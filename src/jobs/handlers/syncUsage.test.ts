import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * نداءات الـ RPC التي وصلت إلى عميل الشركة، والرد الذي يعيده لها.
 */
const mocks = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ companyId: string; name: string }>,
  rpcReply: { data: 0 as number | null, error: null as { message: string } | null },
}));

// The handler reaches Postgres through the company client, which is the
// boundary this test replaces: the counting itself lives in the database, so
// the fake answers the RPC and records who asked for it.
vi.mock("@/company/companyClient.server", () => ({
  companyClient: (companyId: string) => ({
    rpc: async (name: string) => {
      mocks.rpcCalls.push({ companyId, name });
      return { data: mocks.rpcReply.data, error: mocks.rpcReply.error };
    },
  }),
}));

import { createUsageRebuildHandler, type UsageRebuildResult } from "./syncUsage";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

/** يشغّل المعالج بحمولة الليلة كما يوزّعها الجدول على شركة واحدة. */
async function runHandler(companyId = COMPANY_A, date = "2026-11-28"): Promise<UsageRebuildResult> {
  const handler = createUsageRebuildHandler();
  return (await handler({
    jobRequestId: JOB_ID,
    companyId,
    payload: { date },
    attempt: 1,
  })) as UsageRebuildResult;
}

beforeEach(() => {
  mocks.rpcCalls.length = 0;
  mocks.rpcReply = { data: 0, error: null };
});

describe("the usage.rebuild handler", () => {
  it.each([0, 4096, 1_048_576])("rebuilds the total and returns %i bytes", async (bytes) => {
    mocks.rpcReply = { data: bytes, error: null };

    const result = await runHandler();

    expect(result).toEqual({ storageBytes: bytes });
    expect(mocks.rpcCalls).toEqual([
      { companyId: COMPANY_A, name: "rebuild_company_storage_usage" },
    ]);
  });

  it("rebuilds the company of the job and not another one", async () => {
    mocks.rpcReply = { data: 1024, error: null };

    await runHandler(COMPANY_B);

    // The client is bound to one company, so the rebuild can only ever sum
    // that company's files — a job never rebuilds somebody else's total.
    expect(mocks.rpcCalls).toEqual([
      { companyId: COMPANY_B, name: "rebuild_company_storage_usage" },
    ]);
  });

  it("surfaces the RPC failure as a thrown error", async () => {
    mocks.rpcReply = { data: null, error: { message: "permission denied" } };

    await expect(runHandler()).rejects.toThrow(/storage usage rebuild failed: permission denied/);
  });

  it("fails when the rebuild returns no total", async () => {
    mocks.rpcReply = { data: null, error: null };

    await expect(runHandler()).rejects.toThrow(/returned no total/);
  });

  it("a retry rebuilds again instead of skipping the work", async () => {
    mocks.rpcReply = { data: 2048, error: null };

    const first = await runHandler();
    const second = await runHandler();

    // The RPC recomputes from the stored objects rather than adding to the
    // counter, so a retry reaches the same total (contracts/jobs.md section 3).
    expect(first).toEqual(second);
    expect(mocks.rpcCalls).toHaveLength(2);
  });
});
