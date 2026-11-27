import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Redis } from "ioredis";

import type { RelayClaimRow, RelayQueue } from "@/worker/relay";
import { createQueue } from "@/worker/queues";

/**
 * طابور BullMQ وهمي يطبّق قاعدته الموثّقة: إضافة مهمة بمعرّف موجود تُتجاهل،
 * والمهمة المكتملة أو الفاشلة تُزال من الطابور فقط إذا كان خيار `removeOn*`
 * مفعّلاً.
 *
 * The rule is the whole point of the queue options: the BullMQ job id is the
 * `job_requests` row id, so a job left in Redis keeps holding that id and the
 * relay's re-add of a retried row would be ignored.
 */
const { FakeBullQueue, createdQueues } = vi.hoisted(() => {
  class FakeBullQueue {
    readonly adds: Array<{ name: string; jobId?: string }> = [];
    private readonly heldJobIds = new Set<string>();

    constructor(
      readonly name: string,
      readonly options: {
        defaultJobOptions?: { removeOnComplete?: boolean; removeOnFail?: boolean };
      },
    ) {}

    async add(name: string, _data: unknown, opts?: { jobId?: string }) {
      const jobId = opts?.jobId;
      if (jobId && this.heldJobIds.has(jobId)) return { id: jobId, duplicate: true };
      if (jobId) this.heldJobIds.add(jobId);
      this.adds.push({ name, jobId });
      return { id: jobId };
    }

    /** ينهي مهمة كمكتملة أو فاشلة، كما ينهيها BullMQ. */
    finish(jobId: string, outcome: "completed" | "failed"): void {
      const remove =
        outcome === "completed"
          ? this.options.defaultJobOptions?.removeOnComplete
          : this.options.defaultJobOptions?.removeOnFail;
      if (remove) this.heldJobIds.delete(jobId);
    }
  }

  return { FakeBullQueue, createdQueues: [] as FakeBullQueue[] };
});

vi.mock("bullmq", () => ({
  Queue: class extends FakeBullQueue {
    constructor(name: string, options: unknown) {
      super(
        name,
        options as { defaultJobOptions?: { removeOnComplete?: boolean; removeOnFail?: boolean } },
      );
      createdQueues.push(this);
    }
  },
}));

// The relay reaches Supabase through the service-role client; the unit test
// drives it with fakes, so the real client must never be built here.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: vi.fn() },
}));

const { relayOnce } = await import("@/worker/relay");

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

/** صفٌّ محجوز كما يعيده `relay_claim_jobs`. */
function claimedRow(): RelayClaimRow {
  return { id: ROW_ID, company_id: COMPANY_ID, kind: "notification.dispatch" };
}

/** قاعدة بيانات المرحِّل الوهمية: تُعيد الصف نفسه في كل جولة. */
function fakeDatabase() {
  return {
    rpc: vi.fn().mockResolvedValue({ data: [claimedRow()], error: null }),
    resetToPending: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

/** يربط طابور BullMQ الوهمي بمنفذ المرحِّل. */
function asRelayQueue(queue: InstanceType<typeof FakeBullQueue>): RelayQueue {
  return queue as unknown as RelayQueue;
}

beforeEach(() => {
  vi.clearAllMocks();
  createdQueues.length = 0;
});

describe("the queue releases a finished job's id so a retried row runs again", () => {
  test("the queue removes finished and failed jobs", () => {
    createQueue("notify", {} as Redis);

    expect(createdQueues[0].options.defaultJobOptions).toMatchObject({
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  test.each(["completed", "failed"] as const)(
    "a row whose job %s is retried is published again under the same job id",
    async (outcome) => {
      createQueue("notify", {} as Redis);
      const queue = createdQueues[0];
      const db = fakeDatabase();

      await relayOnce({ db, queueFor: () => asRelayQueue(queue) });
      // The job ends, and BullMQ keeps it unless the queue removes it.
      queue.finish(ROW_ID, outcome);
      // The admin retries the row, so the relay claims it again.
      await relayOnce({ db, queueFor: () => asRelayQueue(queue) });

      expect(queue.adds.map((entry) => entry.jobId)).toEqual([ROW_ID, ROW_ID]);
    },
  );
});
