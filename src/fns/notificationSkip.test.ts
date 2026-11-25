/**
 * فحص التكرار يرمي عند فشل الاستعلام، والتخطّي الطبيعي لا يُبلَّغ عنه.
 *
 * The nine copies this replaced all failed OPEN — a query error read as "not
 * yet notified" and the admin got a duplicate email. The fail-closed test
 * below is the regression guard for that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const limit = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "contains", "neq"]) builder[m] = () => builder;
  builder.limit = (...args: unknown[]) => limit(...args);
  return { supabaseAdmin: builder };
});

const { alreadyNotified, isReportableSkip } = await import("@/fns/notificationSkip");

beforeEach(() => limit.mockReset());

describe("alreadyNotified", () => {
  it("is true when a matching notification exists", async () => {
    limit.mockResolvedValueOnce({ data: [{ id: "n1" }], error: null });
    await expect(alreadyNotified("invoice_disputed", { invoice_id: "i1" })).resolves.toBe(true);
  });

  it("is false when none exists", async () => {
    limit.mockResolvedValueOnce({ data: [], error: null });
    await expect(alreadyNotified("invoice_disputed", { invoice_id: "i1" })).resolves.toBe(false);
  });

  it("throws on a query error instead of answering 'not yet notified'", async () => {
    limit.mockResolvedValueOnce({ data: null, error: { message: "connection reset" } });
    await expect(alreadyNotified("invoice_disputed", { invoice_id: "i1" })).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("isReportableSkip", () => {
  it.each([
    ["a sent notification", { skipped: false }, false],
    ["a benign skip", { skipped: true, reason: "Already notified.", benign: true }, false],
    ["a skip the sender did not mark benign", { skipped: true, reason: "No admin email." }, true],
  ])("%s", (_label, result, expected) => {
    expect(isReportableSkip(result as { skipped: boolean })).toBe(expected);
  });
});
