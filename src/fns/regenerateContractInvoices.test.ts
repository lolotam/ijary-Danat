import { beforeEach, describe, expect, it, test, vi } from "vitest";

import { JOB_CATALOG } from "@/jobs/catalog";

import {
  createFakeDb,
  fakeClient,
  fakeRequestContext,
  requestCompanyModule,
  resetFakeDb,
  seedTable,
  tanstackStartModule,
  type FakeDb,
} from "@/jobs/handlers/bulkHandlers.testkit";

vi.mock("@tanstack/react-start", () => tanstackStartModule());
vi.mock("@/company/requestCompany.server", () => requestCompanyModule());
vi.mock("@/company/companyClient.server", () => ({ companyClient: () => fakeClient(fake) }));

const fake: FakeDb = createFakeDb();
const { regenerateContractInvoices, summarizeRegeneration } =
  await import("./regenerateContractInvoices");

const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

/** ينادي دالة الخادم كما يناديها مسار حفظ العقد. */
function callRegenerate(data: unknown, permission = true) {
  const { context } = fakeRequestContext(permission);
  return (
    regenerateContractInvoices as unknown as (a: {
      data: unknown;
      context: unknown;
    }) => Promise<{ queued: true; jobRequestId: string }>
  )({ data, context });
}

describe("summarizeRegeneration", () => {
  test("counts each action separately", () => {
    expect(
      summarizeRegeneration([
        { action: "updated" },
        { action: "updated" },
        { action: "inserted" },
        { action: "cancelled" },
        { action: "skipped" },
        { action: "deleted" },
        { action: "blocked" },
      ]),
    ).toEqual({ updated: 2, inserted: 1, cancelled: 1, deleted: 1, skipped: 1, blocked: 1 });
  });

  test("surfaces cancellations rather than folding them into a total", () => {
    // A cancelled invoice left the contract's range while still carrying money
    // or a live payment link — it needs a human. A single count would bury it.
    const summary = summarizeRegeneration([
      { action: "updated" },
      { action: "updated" },
      { action: "cancelled" },
    ]);
    expect(summary.cancelled).toBe(1);
  });

  test("surfaces blocked months, which claim no synchronisation happened", () => {
    // Migration 139: a month the contract says is billable that the engine
    // refuses to touch — a discounted invoice inside a newly-free month, or a
    // month whose only invoice is cancelled. Reporting a clean result for those
    // would claim a synchronisation that did not happen.
    const summary = summarizeRegeneration([{ action: "updated" }, { action: "blocked" }]);
    expect(summary.blocked).toBe(1);
  });

  test("an empty or absent result is all zeros, not a crash", () => {
    const zero = { updated: 0, inserted: 0, cancelled: 0, deleted: 0, skipped: 0, blocked: 0 };
    expect(summarizeRegeneration([])).toEqual(zero);
    expect(summarizeRegeneration(null)).toEqual(zero);
    expect(summarizeRegeneration(undefined)).toEqual(zero);
  });

  test("an unrecognised action is ignored rather than creating a key", () => {
    const summary = summarizeRegeneration([{ action: "teleported" }, { action: "updated" }]);
    expect(summary).toEqual({
      updated: 1,
      inserted: 0,
      cancelled: 0,
      deleted: 0,
      skipped: 0,
      blocked: 0,
    });
  });
});

beforeEach(() => {
  resetFakeDb(fake);
  seedTable(fake, "contracts", [{ id: CONTRACT_ID }]);
});

describe("regenerateContractInvoices server function", () => {
  it("enqueues exactly one catalogue-valid invoices.regenerate job and reconciles nothing here", async () => {
    const result = await callRegenerate({ contractId: CONTRACT_ID });

    // The request does no bulk work: one outbox row carrying the contract and
    // this request's own id — the dedupe key is contract + request id
    // (contracts/jobs.md section 5), so each deliberate submit gets its job.
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0].kind).toBe("invoices.regenerate");
    const payload = fake.jobs[0].payload as { contractId: string; requestId: string };
    expect(payload.contractId).toBe(CONTRACT_ID);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.jobs[0].dedupeKey).toBe(`invoices.regenerate:${CONTRACT_ID}:${payload.requestId}`);
    expect(() => JOB_CATALOG["invoices.regenerate"].payload.parse(payload)).not.toThrow();
    expect(fake.rpcs.filter((call) => call.name === "regenerate_contract_invoices")).toEqual([]);
    expect(result.queued).toBe(true);
    expect(result.jobRequestId).toBe(fake.jobs[0].id);
  });

  it("fails in the request when the contract is not this company's", async () => {
    // The contract is read here so a wrong id fails on screen, not a minute
    // later in a job with nothing to say which contract it was.
    resetFakeDb(fake);

    await expect(callRegenerate({ contractId: CONTRACT_ID })).rejects.toThrow("Contract not found");
    expect(fake.jobs).toEqual([]);
  });

  // Regression guard for the audit finding: the guard used to
  // `throw new Response("Forbidden", { status: 403 })`, which TanStack Start
  // hands back to the caller instead of rejecting — the await resolved and the
  // contract save toasted success while its invoices were never reconciled.
  // The refusal must reject with a named Error, and no job may be enqueued.
  it("rejects with a permission Error when user lacks permission", async () => {
    await expect(callRegenerate({ contractId: CONTRACT_ID }, false)).rejects.toThrow(
      "You do not have permission to regenerate contract invoices.",
    );

    expect(fake.jobs).toEqual([]);
    expect(fake.rpcs.filter((call) => call.name === "regenerate_contract_invoices")).toEqual([]);
  });
});
