import { Queue, type BackoffOptions } from "bullmq";
import { Redis } from "ioredis";

import { QUEUE_NAMES, type QueueName } from "@/jobs/catalog";

import type { RelayedJobData } from "./types";

/** إعدادات طابور واحد: عدد المهام المتزامنة وعدد المحاولات وتأخير إعادة المحاولة. */
export interface QueueConfig {
  concurrency: number;
  attempts: number;
  backoff?: BackoffOptions;
}

/**
 * إعدادات كل طابور كما يقرّرها contracts/jobs.md section 4.
 *
 * Only `notify` states a backoff (exponential from 30 s); the other queues get
 * the same one so a failing job never retries in a tight loop. `cron` runs each
 * job once, so it has no backoff at all.
 */
export const QUEUE_CONFIGS: Record<QueueName, QueueConfig> = {
  notify: { concurrency: 10, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  docs: { concurrency: 2, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  bulk: { concurrency: 2, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  sync: { concurrency: 2, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  inbound: { concurrency: 5, attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
  cron: { concurrency: 1, attempts: 1 },
};

/**
 * يبني اتصال ioredis من `REDIS_URL` بعد التحقق منه في `validateEnv`.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: the worker blocks on a
 * long-running command, and BullMQ refuses a connection that carries a finite
 * retry limit.
 */
export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set - call validateEnv() before opening Redis");
  }
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * ينشئ طابور BullMQ باسم الطابور نفسه على الاتصال المشترك.
 *
 * The `job_requests` row is the record of truth and the BullMQ job id is that
 * row's id. A finished or failed job left in Redis would keep holding that id,
 * and BullMQ ignores an add for an id it already holds — so a retried row
 * would be published again and never run. Removing both sets frees the id.
 */
export function createQueue(name: QueueName, connection: Redis): Queue<RelayedJobData> {
  return new Queue<RelayedJobData>(name, {
    connection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
  });
}

/**
 * ينشئ طابوراً لكل طابور معروف ويعيد السجلّ الذي يربط كل اسم بطابوره.
 *
 * The cast narrows the index signature `Object.fromEntries` returns to the
 * six known queue names — every one of them is created right above.
 */
export function createQueues(connection: Redis): Record<QueueName, Queue<RelayedJobData>> {
  return Object.fromEntries(
    QUEUE_NAMES.map((name) => [name, createQueue(name, connection)]),
  ) as Record<QueueName, Queue<RelayedJobData>>;
}
