import { afterEach, describe, expect, test, vi } from "vitest";

import type { QueueName } from "@/jobs/catalog";

// The relay reaches Supabase through the service-role client. The unit tests
// drive it with fakes, so the real client must never be built here.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: vi.fn() },
}));

import { relayOnce, type RelayClaimRow } from "@/worker/relay";

afterEach(() => {
  vi.restoreAllMocks();
});

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const COMPANY_C = "33333333-3333-4333-8333-333333333333";
const ROW_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROW_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ROW_C = "cccccccc-3333-4333-8333-cccccccccccc";

/** صفٌّ محجوز كما يعيده `relay_claim_jobs`. */
function claimedRow(id: string, companyId: string, kind: string): RelayClaimRow {
  return { id, company_id: companyId, kind };
}

/** عميل Supabase وهمي يعيد الصفوف المحجوزة أو خطأً، ويسجّل ما كُتب فيه. */
function fakeDatabase(rows: RelayClaimRow[], error: { message: string } | null = null) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rows, error }),
    resetToPending: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

/** طابور BullMQ وهمي يسجّل ما أُضيف إليه. */
function fakeQueue() {
  return { add: vi.fn().mockResolvedValue(undefined) };
}

/**
 * أنواع المهام وطوابيرها كما يقرّرها الكتالوج، مع إعدادات المحاولات الموثّقة
 * في contracts/jobs.md section 4.
 */
const PUBLISH_CASES = [
  {
    kind: "notification.dispatch",
    queue: "notify",
    options: { jobId: ROW_A, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  },
  {
    kind: "notification.bulk",
    queue: "bulk",
    options: { jobId: ROW_A, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  },
  {
    kind: "contract.pdf",
    queue: "docs",
    options: { jobId: ROW_A, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  },
  {
    kind: "company.export",
    queue: "sync",
    options: { jobId: ROW_A, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  },
  {
    kind: "payment.settle",
    queue: "inbound",
    options: { jobId: ROW_A, attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
  },
  {
    kind: "subscription.remind",
    queue: "cron",
    options: { jobId: ROW_A, attempts: 1 },
  },
] as const;

describe("the relay publishes claimed job_requests rows to BullMQ (T054)", () => {
  test.each(PUBLISH_CASES)(
    "a $kind job goes to the $queue queue with that queue's attempts",
    async ({ kind, queue, options }) => {
      const add = vi.fn().mockResolvedValue(undefined);
      const requested: QueueName[] = [];
      const db = fakeDatabase([claimedRow(ROW_A, COMPANY_A, kind)]);

      const published = await relayOnce({
        db,
        queueFor: (name) => {
          requested.push(name);
          return { add };
        },
      });

      expect(published).toBe(1);
      expect(requested).toEqual([queue]);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        kind,
        { jobRequestId: ROW_A, companyId: COMPANY_A },
        options,
      );
    },
  );

  test("every claimed row is published once, to the queue its kind names", async () => {
    const notifyQueue = fakeQueue();
    const bulkQueue = fakeQueue();
    const queues = new Map<QueueName, ReturnType<typeof fakeQueue>>([
      ["notify", notifyQueue],
      ["bulk", bulkQueue],
    ]);
    const db = fakeDatabase([
      claimedRow(ROW_A, COMPANY_A, "notification.dispatch"),
      claimedRow(ROW_B, COMPANY_B, "notification.bulk"),
    ]);

    const published = await relayOnce({
      db,
      queueFor: (name) => {
        const queue = queues.get(name);
        if (!queue) throw new Error(`unexpected queue: ${name}`);
        return queue;
      },
    });

    expect(published).toBe(2);
    expect(notifyQueue.add).toHaveBeenCalledTimes(1);
    expect(bulkQueue.add).toHaveBeenCalledTimes(1);
  });

  test("a row published again keeps the same BullMQ job id, so the duplicate is ignored", async () => {
    const queue = fakeQueue();
    const db = fakeDatabase([claimedRow(ROW_A, COMPANY_A, "notification.dispatch")]);

    await relayOnce({ db, queueFor: () => queue });
    await relayOnce({ db, queueFor: () => queue });

    expect(queue.add.mock.calls.map((call) => call[2]?.jobId)).toEqual([ROW_A, ROW_A]);
  });

  test("a kind outside the catalogue fails the row, and the other rows still publish", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = fakeQueue();
    const db = fakeDatabase([
      claimedRow(ROW_A, COMPANY_A, "invoice.teleport"),
      claimedRow(ROW_B, COMPANY_B, "notification.bulk"),
    ]);

    const published = await relayOnce({ db, queueFor: () => queue });

    expect(published).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "notification.bulk",
      { jobRequestId: ROW_B, companyId: COMPANY_B },
      expect.objectContaining({ jobId: ROW_B }),
    );
    expect(db.markFailed).toHaveBeenCalledWith(
      { id: ROW_A, company_id: COMPANY_A },
      "unknown job kind: invoice.teleport",
    );
    expect(consoleError).toHaveBeenCalled();
  });

  test("a queue that refuses one row sends it back to pending and publishes the rest", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const add = vi
      .fn()
      .mockImplementation(async (_name: string, data: { jobRequestId: string }) => {
        if (data.jobRequestId === ROW_B) throw new Error("redis is down");
        return undefined;
      });
    const db = fakeDatabase([
      claimedRow(ROW_A, COMPANY_A, "notification.dispatch"),
      claimedRow(ROW_B, COMPANY_B, "notification.bulk"),
      claimedRow(ROW_C, COMPANY_C, "notification.dispatch"),
    ]);

    const published = await relayOnce({ db, queueFor: () => ({ add }) });

    expect(published).toBe(2);
    expect(db.resetToPending).toHaveBeenCalledTimes(1);
    expect(db.resetToPending).toHaveBeenCalledWith({ id: ROW_B, company_id: COMPANY_B });
    expect(db.markFailed).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  test("a failed claim throws, so the round fails loudly instead of publishing nothing quietly", async () => {
    const queue = fakeQueue();
    const db = fakeDatabase([], { message: "connection refused" });

    await expect(relayOnce({ db, queueFor: () => queue })).rejects.toThrow(
      "relay_claim_jobs failed: connection refused",
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  test("the claim asks for at most 100 rows", async () => {
    const db = fakeDatabase([]);

    await relayOnce({ db, queueFor: () => fakeQueue() });

    expect(db.rpc).toHaveBeenCalledWith("relay_claim_jobs", { _limit: 100 });
  });
});
