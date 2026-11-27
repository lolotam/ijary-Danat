import { Worker, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";

import { QUEUE_NAMES, type JobKind } from "@/jobs/catalog";
import { createHandlerRegistry } from "@/jobs/handlers/registry";
import { validateEnv } from "@/lib/env.server";

import { createConnectionPacer } from "./pacing";
import { createQueues, createRedisConnection, QUEUE_CONFIGS } from "./queues";
import { startRelay } from "./relay";
import { createRunJob } from "./runJob";
import { runJobPorts } from "./runJobPorts";
import {
  createFanOutProcessor,
  scheduleFromJobName,
  schedulerDatabase,
  startScheduler,
} from "./scheduler";
import type { JobAttempt, ProcessJob, RelayedJobData } from "./types";

/**
 * يحوّل مهمة BullMQ إلى محاولة تنفيذ واحدة بصيغة `job_requests`.
 */
function toJobAttempt(job: Job<RelayedJobData>): JobAttempt {
  return {
    // The relay names every job after its kind, so the queue and the
    // catalogue always agree on what this job is.
    kind: job.name as JobKind,
    jobRequestId: job.data.jobRequestId,
    companyId: job.data.companyId,
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts ?? 1,
  };
}

/**
 * يبني قفل الإيقاع على اتصال Redis نفسه الذي يستخدمه العامل.
 *
 * The lock has to hold across every worker process, so it lives in Redis; the
 * worker hands over the connection it already opened (research.md R7).
 */
function createPace(connection: Redis): (connectionKey: string) => Promise<void> {
  const pacer = createConnectionPacer({ redis: connection });
  return (connectionKey) => pacer.waitForSlot(connectionKey);
}

/**
 * ينشئ عاملاً لكل طابور بالتزامنه الموثّق في contracts/jobs.md section 4.
 *
 * The `cron` queue carries two shapes: the fan-out the scheduler fires, and a
 * relayed row a company filed. The fan-out is recognised by its name, so a
 * relayed row on the same queue still goes through the job wrapper.
 */
function createWorkers(
  connection: Redis,
  processJob: ProcessJob,
  processCronJob: (job: Job<RelayedJobData>) => Promise<void>,
): Array<Worker<RelayedJobData>> {
  return QUEUE_NAMES.map(
    (name) =>
      new Worker<RelayedJobData>(
        name,
        (job) => (name === "cron" ? processCronJob(job) : processJob(toJobAttempt(job))),
        {
          connection,
          concurrency: QUEUE_CONFIGS[name].concurrency,
        },
      ),
  );
}

/**
 * يسجّل أخطاء العامل والطوابير: حدث `error` غير المُراقَب في BullMQ يُنهي
 * العملية، وRedis يفصل ويتصل طوال يوم العمل.
 */
function reportFailures(
  workers: Array<Worker<RelayedJobData>>,
  queues: Array<Queue<RelayedJobData>>,
): void {
  for (const worker of workers) {
    worker.on("error", (error) => {
      console.error(`[worker] ${worker.name} failed:`, error);
    });
  }
  for (const queue of queues) {
    queue.on("error", (error) => {
      console.error(`[worker] queue ${queue.name} failed:`, error);
    });
  }
}

/** ما يحتاجه الإيقاف قبل الخروج من العملية. */
interface ShutdownTargets {
  stopRelay: () => void;
  stopScheduler: () => Promise<void>;
  workers: Array<Worker<RelayedJobData>>;
  queues: Array<Queue<RelayedJobData>>;
  connection: Redis;
}

/**
 * يوقف المرحِّل والعاملين ويغلق الطوابير واتصال Redis قبل الخروج.
 */
async function shutdown(targets: ShutdownTargets): Promise<void> {
  targets.stopRelay();
  await targets.stopScheduler();
  await Promise.all(targets.workers.map((worker) => worker.close()));
  await Promise.all(targets.queues.map((queue) => queue.close()));
  await targets.connection.quit();
}

/**
 * يبني مستمع إشارات النظام الذي يوقف العامل ثم يخرج بالرمز المناسب.
 *
 * The flag keeps a second signal from closing Redis twice, which would end the
 * process with a failure code after a clean shutdown.
 */
function createSignalHandler(targets: ShutdownTargets): (signal: NodeJS.Signals) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) return;
    stopping = true;
    console.warn(`[worker] ${signal} received, shutting down`);
    shutdown(targets)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("[worker] shutdown failed:", error);
        process.exit(1);
      });
  };
}

/**
 * يشغّل العامل الخلفي: عاملاً لكل طابور، ومرحِّلاً ينشر الطلبات المحجوزة،
 * ومجدولاً يوزّع العمل المجدول على الشركات.
 */
async function startWorker(): Promise<void> {
  validateEnv();

  const connection = createRedisConnection();
  const queues = createQueues(connection);
  const queueList = Object.values(queues);
  const processJob = createRunJob(
    runJobPorts,
    createHandlerRegistry({ pace: createPace(connection) }),
  );
  const fanOutProcessor = createFanOutProcessor(schedulerDatabase);
  const processCronJob = async (job: Job<RelayedJobData>): Promise<void> => {
    if (scheduleFromJobName(job.name)) {
      await fanOutProcessor(job);
      return;
    }
    await processJob(toJobAttempt(job));
  };
  const workers = createWorkers(connection, processJob, processCronJob);
  reportFailures(workers, queueList);
  const scheduler = await startScheduler(queues.cron);

  const targets: ShutdownTargets = {
    stopRelay: startRelay((name) => queues[name]),
    stopScheduler: () => scheduler.stop(),
    workers,
    queues: queueList,
    connection,
  };
  const onSignal = createSignalHandler(targets);

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

await startWorker();
