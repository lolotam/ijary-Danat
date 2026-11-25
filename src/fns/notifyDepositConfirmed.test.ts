import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const depositRow = vi.fn();
const templateRow = vi.fn();
const notificationsQuery = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const DEPOSIT_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "notification_templates") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: templateRow }),
            }),
          }),
        };
      }
      if (table === "deposits") {
        return {
          select: () => ({
            eq: () => ({ single: depositRow, maybeSingle: depositRow }),
          }),
        };
      }
      if (table === "notifications") {
        return {
          select: () => ({
            eq: () => ({
              contains: () => ({
                neq: () => ({
                  limit: notificationsQuery,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "companies") {
        return {
          select: () => ({
            order: () => ({
              limit: () => ({ maybeSingle }),
            }),
          }),
        };
      }
      if (table === "cron_jobs") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle, single: depositRow }),
        }),
      };
    },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const resolveRecipients = vi.fn(async (targets: string[]) =>
  targets.includes("admin") || targets.includes("company")
    ? targets.includes("company") && !targets.includes("admin")
      ? ["company@example.test"]
      : ["admin@example.test"]
    : [],
);

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: (...args: unknown[]) => resolveRecipients(...(args as [string[]])),
}));

const { notifyDepositConfirmedRecord } = await import("./notifyDepositConfirmed");
const { runEventWorkflow } = await import("./workflowRegistry");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  // Default: workflow paused (is_active false) so existing pause tests stay simple.
  maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
  depositRow.mockResolvedValue({
    data: {
      id: DEPOSIT_ID,
      status: "confirmed",
      amount: 1000,
      currency: "KWD",
      bank_name: "NBK",
      deposit_date: "2026-08-01",
      code: "DEP-1",
      note: null,
      attachment_path: null,
    },
    error: null,
  });
  notificationsQuery.mockResolvedValue({ data: [], error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "note-1" });
});

describe("the deposit-confirmed workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    // The switch must be READ, not merely written. Asserting on the return flag
    // and on enqueueNotification never being called is the only way to catch a
    // toggle that is stored and then ignored.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("pausing consults this workflow's own row", async () => {
    // Four event rows share one table; a sender reading the wrong key would
    // make one switch silently control another.
    maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "skipped" }),
    );
  });
});

describe("classifying what the sender did", () => {
  test("an active workflow that had nothing to do records skipped, not success", async () => {
    // This sender skips for three normal reasons — not confirmed, already
    // notified, no admin recipients. Recording those as successes would hide
    // the third, which is a real misconfiguration. A green row that means
    // "sent nothing" is worse than no row at all.
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });

    await runEventWorkflow({
      key: "deposit-confirmed",
      whenPaused: () => ({ skipped: true as const, reason: "paused" }),
      run: async () => ({ skipped: true as const, reason: "Already notified." }),
      outcomeOf: (result: { skipped: boolean; reason?: string }) =>
        result.skipped
          ? { status: "skipped" as const, error: result.reason ?? null }
          : { status: "success" as const, error: null },
    });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });
});

describe("a template that excludes the email channel", () => {
  test("is recorded as a skip with its reason, not as a successful send", async () => {
    maybeSingle.mockResolvedValue({ data: { is_active: true }, error: null });
    enqueue.mockResolvedValue(null);

    const result = await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(result).toEqual({
      skipped: true,
      reason: "Template deposit-confirmation excludes the email channel.",
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "deposit-confirmed", _status: "skipped" }),
    );
  });
});

describe("authoritative template body", () => {
  test("the stored template body reaches the enqueued notification", async () => {
    // The assertion that would have failed for all six senders before this piece:
    // it proves the row is actually READ, not merely tagged on the notification.
    // cron_jobs is_active: true; companies default_locale: en
    maybeSingle
      .mockResolvedValueOnce({ data: { is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { default_locale: "en" }, error: null });
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR-MARKER</p>",
        body_en: "<p>EN-MARKER</p>",
      },
      error: null,
    });

    await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(enqueue).toHaveBeenCalled();
    const body = enqueue.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("EN-MARKER");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { default_locale: "en" }, error: null });
    templateRow.mockResolvedValue({ data: null, error: null });

    await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(enqueue).toHaveBeenCalled();
    const body = enqueue.mock.calls[0]?.[0]?.body as string;
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("recipient targets are address-level for admin/company", () => {
  test("admin off + company on still enqueues to the company email", async () => {
    maybeSingle
      .mockResolvedValueOnce({
        data: { is_active: true, recipient_targets: ["company"] },
        error: null,
      })
      .mockResolvedValueOnce({ data: { default_locale: "en" }, error: null });

    await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]?.recipientAddress).toBe("company@example.test");
  });
});

describe("the eligibility gate does not wrap automatic senders", () => {
  test("still enqueues the staff deposit alert", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { is_active: true }, error: null })
      .mockResolvedValueOnce({ data: { default_locale: "en" }, error: null });

    await notifyDepositConfirmedRecord(DEPOSIT_ID);

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "deposit_confirmation",
        templateCode: "deposit-confirmation",
      }),
    );
  });
});
