import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMock = vi.fn();
const retryMock = vi.fn();

vi.mock("@/fns/dispatchNotification", () => ({
  dispatchNotificationRecord: (id: string) => dispatchMock(id),
  retryFailedNotificationRecord: (id: string, seenRetryCount: number) =>
    retryMock(id, seenRetryCount),
}));

/**
 * Table-routed fake for supabaseAdmin. Only the database boundary is faked; the
 * job's own selection rules are exercised for real.
 *
 * `select` is recorded and used to project `db.pending`: a fixture field the
 * job did not ask for never reaches the loop. That is what makes a missing
 * `error_code` in the production select fail the review-guard tests, instead
 * of the tests passing against a hand-built row PostgREST would never return.
 */
const db = {
  pending: [] as Record<string, unknown>[],
  pendingSelect: null as string | null,
  updates: [] as {
    id: string;
    values: Record<string, unknown>;
    eqs: Array<[string, string]>;
  }[],
  audit: null as Record<string, unknown> | null,
  inFlightJobs: [] as Record<string, unknown>[],
  jobRequestsSelect: null as string | null,
};

/**
 * يُسقط صف الإشعار على الأعمدة التي طلبها `.select(...)` فقط.
 *
 * Mirrors PostgREST: omitted columns are absent, not present-as-undefined
 * on a fat fixture. The review guard would otherwise pass in tests and
 * never fire in production.
 */
function projectSelected(
  row: Record<string, unknown>,
  columns: string | null,
): Record<string, unknown> {
  if (!columns) return { ...row };
  const projected: Record<string, unknown> = {};
  for (const key of columns
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    projected[key] = row[key];
  }
  return projected;
}

/** شرط مُطبَّق على صف `job_requests` في الاستعلام الوهمي. */
type JobFilter =
  | { op: "eq"; column: string; value: string }
  | { op: "in"; column: string; values: string[] };

/**
 * يطابق صف `job_requests` مع شروط الاستعلام كما يفعل PostgREST.
 */
function matchesJobFilters(row: Record<string, unknown>, filters: JobFilter[]): boolean {
  return filters.every((filter) =>
    filter.op === "eq"
      ? String(row[filter.column]) === filter.value
      : filter.values.includes(String(row[filter.column])),
  );
}

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => {
  function builder(table: string) {
    const chain: any = {
      _id: null as string | null,
      _values: null as Record<string, unknown> | null,
      _eqs: [] as Array<[string, string]>,
      _select: null as string | null,
      _filters: [] as JobFilter[],
      select(columns: string) {
        chain._select = columns;
        if (table === "notifications") db.pendingSelect = columns;
        else db.jobRequestsSelect = columns;
        return chain;
      },
      in: (column: string, values: string[]) => {
        chain._filters.push({ op: "in", column, values });
        return chain;
      },
      order: () => chain,
      limit: () =>
        Promise.resolve({
          data: db.pending.map((row) => projectSelected(row, chain._select)),
          error: null,
        }),
      update(values: Record<string, unknown>) {
        chain._values = values;
        return chain;
      },
      eq(column: string, value: string) {
        if (column === "id") chain._id = value;
        chain._eqs.push([column, value]);
        chain._filters.push({ op: "eq", column, value });
        return chain;
      },
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (table === "job_requests") {
          const rows = db.inFlightJobs
            .filter((row) => matchesJobFilters(row, chain._filters))
            .map((row) => projectSelected(row, chain._select));
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        }
        if (chain._values && chain._id) {
          db.updates.push({
            id: chain._id,
            values: chain._values,
            eqs: [...chain._eqs],
          });
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }
  return {
    companyClient: () => ({
      from: (table: string) => builder(table),
      rpc: (_name: string, args: Record<string, unknown>) => {
        db.audit = args;
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
});

import {
  runNotificationDrainJob,
  EVOLUTION_NEEDS_REVIEW,
  MAX_RETRIES,
  POSTORA_NEEDS_REVIEW,
  PROVIDER_NEEDS_REVIEW,
  STALE_AFTER_HOURS,
} from "./notificationDrainJob";
import { DELIVERY_INDETERMINATE } from "@/lib/providers/types";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function hoursAgo(hours: number) {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * يبني صف إشعار يمكن إسقاطه على `.select` الحقيقي لمهمة التصريف.
 *
 * Extra keys the job did not ask for never reach the loop — see
 * `projectSelected`. That coupling is the point of the review-guard tests.
 */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    state: "queued",
    channel: "email",
    error_code: null,
    retry_count: 0,
    scheduled_at: hoursAgo(1),
    created_at: hoursAgo(1),
    ...overrides,
  };
}

describe("runNotificationDrainJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db.pending = [];
    db.pendingSelect = null;
    db.updates = [];
    db.audit = null;
    db.inFlightJobs = [];
    db.jobRequestsSelect = null;
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ state: "sent" });
    retryMock.mockReset();
    retryMock.mockResolvedValue({ state: "sent" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches a queued notification whose scheduled time has arrived", async () => {
    db.pending = [row({ id: "due-1" })];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).toHaveBeenCalledWith("due-1");
    expect(result.dispatched).toEqual(["due-1"]);
  });

  it("leaves a notification scheduled for the future untouched", async () => {
    db.pending = [row({ id: "future-1", scheduled_at: hoursAgo(-5) })];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.notYetDue).toBe(1);
    expect(db.updates).toEqual([]);
  });

  it("cancels a stale row instead of sending it", async () => {
    db.pending = [row({ id: "stale-1", scheduled_at: hoursAgo(STALE_AFTER_HOURS + 1) })];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual(["stale-1"]);
    expect(db.updates[0].values).toMatchObject({ state: "cancelled" });
    expect(db.updates[0].values.failure_reason).toMatch(/past due/);
  });

  it("cancels a pre-feature orphan that has no scheduled_at, using created_at", async () => {
    // The two rows stuck queued since 2026-07-18 predate the scheduled_at column.
    // Falling back to created_at is what stops them being blasted on first run.
    db.pending = [
      row({ id: "orphan-1", scheduled_at: null, created_at: "2026-07-18T10:19:11.000Z" }),
    ];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual(["orphan-1"]);
  });

  it("retries a single-channel failure below the attempt ceiling", async () => {
    db.pending = [row({ id: "fail-1", state: "failed", channel: "whatsapp", retry_count: 1 })];

    const result = await runNotificationDrainJob();

    // إعادة المحاولة تمرّ عبر الحجز أولاً (GR-010): ما قرأته الصفّ هو ما يُحجز به.
    expect(retryMock).toHaveBeenCalledWith("fail-1", 1);
    expect(result.retried).toEqual(["fail-1"]);
  });

  it("does not dispatch a failed row another retry path claimed first", async () => {
    // GR-010: مهمة التقرير قد تكون حجزت الصف الفاشل وصرّفته قبل هذا المسح؛
    // الحجز المفقود يعني أن محاولة أخرى تملك الصف الآن، والإرسال هنا كان
    // سيصل المستأجر بالرسالة مرتين.
    db.pending = [row({ id: "claimed-1", state: "failed", channel: "whatsapp", retry_count: 1 })];
    retryMock.mockResolvedValue(null);

    const result = await runNotificationDrainJob();

    expect(retryMock).toHaveBeenCalledWith("claimed-1", 1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(result.retried).toEqual([]);
    expect(result.skippedInFlight).toBe(1);
    expect(db.audit).toMatchObject({
      p_after: { scanned: 1, retried: 0, skipped_in_flight: 1 },
    });
  });

  it.each([{ error_code: null }, { error_code: "rate_limited" }, { error_code: "unknown_error" }])(
    "still retries a failed row whose error_code is $error_code",
    async ({ error_code }) => {
      db.pending = [
        row({
          id: "fail-retry",
          state: "failed",
          channel: "whatsapp",
          retry_count: 1,
          error_code,
        }),
      ];

      const result = await runNotificationDrainJob();

      expect(retryMock).toHaveBeenCalledWith("fail-retry", 1);
      expect(result.retried).toEqual(["fail-retry"]);
      expect(result.heldForReview).toBe(0);
      expect(db.updates).toEqual([]);
    },
  );

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "retries rather than parking when error_code is the inherited property %s",
    async (error_code) => {
      // error_code comes from Postora's JSON. A bare map index would resolve
      // these to inherited functions, read as truthy, and park the row with a
      // failure_reason that JSON.stringify then drops.
      db.pending = [
        row({ id: "proto-1", state: "failed", channel: "whatsapp", retry_count: 1, error_code }),
      ];

      const result = await runNotificationDrainJob();

      expect(result.heldForReview).toBe(0);
      expect(retryMock).toHaveBeenCalledWith("proto-1", 1);
    },
  );

  it("holds an indeterminate Postora failure for review instead of retrying", async () => {
    db.pending = [
      row({
        id: "indet-1",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: "idempotency_indeterminate",
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).not.toHaveBeenCalled();
    expect(result.retried).toEqual([]);
    expect(result.heldForReview).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].id).toBe("indet-1");
    expect(db.updates[0].values).toEqual({
      state: "needs_review",
      failure_reason: expect.stringMatching(/could not confirm/i),
    });
    expect(db.updates[0].values).not.toHaveProperty("retry_count");
    expect(String(db.updates[0].values.failure_reason)).not.toBe("idempotency_indeterminate");
    expect(db.updates[0].eqs).toEqual([
      ["id", "indet-1"],
      ["state", "failed"],
    ]);
    expect(db.audit).toMatchObject({
      p_after: { held_for_review: 1, retried: 0 },
    });
  });

  it.each([
    {
      error_code: "quota_exceeded" as const,
      reasonNeedle: /quota/i,
      actionNeedle: /top up|raise the quota/i,
    },
    {
      error_code: "account_needs_reauth" as const,
      reasonNeedle: /re-authori[sz]e/i,
      actionNeedle: /re-authori[sz]e/i,
    },
    {
      error_code: "idempotency_conflict" as const,
      reasonNeedle: /different request body/i,
      actionNeedle: /row.?s content changed|fresh notification/i,
    },
  ])(
    "holds a $error_code Postora failure for review with its own actionable reason",
    async ({ error_code, reasonNeedle, actionNeedle }) => {
      db.pending = [
        row({
          id: `hold-${error_code}`,
          state: "failed",
          channel: "whatsapp",
          retry_count: 1,
          error_code,
        }),
      ];

      const result = await runNotificationDrainJob();

      expect(retryMock).not.toHaveBeenCalled();
      expect(result.heldForReview).toBe(1);
      expect(db.updates).toHaveLength(1);
      expect(db.updates[0].values).toEqual({
        state: "needs_review",
        failure_reason: POSTORA_NEEDS_REVIEW[error_code],
      });
      const reason = String(db.updates[0].values.failure_reason);
      expect(reason).toMatch(reasonNeedle);
      expect(reason).toMatch(actionNeedle);
      // Each code must keep a distinct sentence — not one generic parking message.
      expect(reason).not.toBe(POSTORA_NEEDS_REVIEW.idempotency_indeterminate);
    },
  );

  it("still retries idempotency_in_progress because a concurrent attempt is still in flight", async () => {
    // Easy mistake: treat every idempotency_* code like indeterminate and park
    // it. in_progress means "try again later", not "human must decide".
    db.pending = [
      row({
        id: "in-flight-1",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: "idempotency_in_progress",
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).toHaveBeenCalledWith("in-flight-1", 1);
    expect(result.retried).toEqual(["in-flight-1"]);
    expect(result.heldForReview).toBe(0);
    expect(db.updates).toEqual([]);
  });

  it("holds a stale indeterminate failure for review rather than cancelling it", async () => {
    // Age is a reason to stop trying, not a reason to conclude the message
    // never arrived. If the stale-cancel branch ran first, this row would be
    // filed as "gave up, too old" and the fact that nobody knows whether the
    // tenant received it would be lost.
    db.pending = [
      row({
        id: "indet-stale",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: "idempotency_indeterminate",
        scheduled_at: hoursAgo(STALE_AFTER_HOURS + 1),
        created_at: hoursAgo(STALE_AFTER_HOURS + 1),
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
    expect(result.heldForReview).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].values).toMatchObject({ state: "needs_review" });
  });

  it.each(["quota_exceeded", "account_needs_reauth", "idempotency_conflict"] as const)(
    "holds a stale %s failure for review rather than cancelling it",
    async (error_code) => {
      db.pending = [
        row({
          id: `stale-${error_code}`,
          state: "failed",
          channel: "whatsapp",
          retry_count: 1,
          error_code,
          scheduled_at: hoursAgo(STALE_AFTER_HOURS + 1),
          created_at: hoursAgo(STALE_AFTER_HOURS + 1),
        }),
      ];

      const result = await runNotificationDrainJob();

      expect(retryMock).not.toHaveBeenCalled();
      expect(result.cancelled).toEqual([]);
      expect(result.heldForReview).toBe(1);
      expect(db.updates[0].values).toMatchObject({
        state: "needs_review",
        failure_reason: POSTORA_NEEDS_REVIEW[error_code],
      });
    },
  );

  it("selects error_code so a reverted query cannot hide an indeterminate failure", async () => {
    db.pending = [
      row({
        id: "indet-select",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: "idempotency_indeterminate",
      }),
    ];

    await runNotificationDrainJob();

    expect(db.pendingSelect).toMatch(/\berror_code\b/);
  });

  it("parks a row that exhausted its retries in needs_review, keeping the last reason", async () => {
    // Nine overdue reminders sat in `failed` with "transiently (500)" after
    // three silent retries on 2026-09-02 — nothing in the log said a human had
    // to act. Exhaustion IS the signal: the row moves where admins look.
    db.pending = [
      row({
        id: "fail-2",
        state: "failed",
        channel: "whatsapp",
        retry_count: MAX_RETRIES,
        error_code: "unknown_error",
        failure_reason: "Evolution send failed transiently (500).",
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).not.toHaveBeenCalled();
    expect(result.heldForReview).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].id).toBe("fail-2");
    expect(db.updates[0].values.state).toBe("needs_review");
    const reason = String(db.updates[0].values.failure_reason);
    expect(reason).toMatch(new RegExp(`${MAX_RETRIES} attempts`));
    expect(reason).toContain("Evolution send failed transiently (500).");
    // Conditional on the state it read, like every other transition here.
    expect(db.updates[0].eqs).toContainEqual(["state", "failed"]);
  });

  it("never auto-retries a failed channel:both row, which may have half-sent", async () => {
    // dispatchNotificationRecord discards message ids when a later leg throws,
    // so a `both` row can read failed with its email already delivered.
    db.pending = [row({ id: "both-1", state: "failed", channel: "both", retry_count: 0 })];

    const result = await runNotificationDrainJob();

    expect(retryMock).not.toHaveBeenCalled();
    expect(result.heldForReview).toBe(1);
    expect(result.retried).toEqual([]);
  });

  it("does not count a dispatch that failed again as delivered", async () => {
    db.pending = [row({ id: "still-bad" })];
    dispatchMock.mockResolvedValue({ state: "failed" });

    const result = await runNotificationDrainJob();

    expect(result.dispatched).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("records the run outcome for unattended visibility", async () => {
    db.pending = [
      row({ id: "due-1" }),
      row({ id: "stale-1", scheduled_at: hoursAgo(STALE_AFTER_HOURS + 1) }),
      row({ id: "future-1", scheduled_at: hoursAgo(-5) }),
    ];

    await runNotificationDrainJob();

    expect(db.audit).toMatchObject({
      p_action: "job.notification_drain",
      p_after: { scanned: 3, dispatched: 1, cancelled: 1, not_yet_due: 1 },
    });
  });

  it.each([
    {
      error_code: "session_disconnected" as const,
      reasonNeedle: /re-scan the qr/i,
    },
    {
      error_code: "instance_missing" as const,
      reasonNeedle: /re-connect from settings/i,
    },
    {
      error_code: "number_not_on_whatsapp" as const,
      reasonNeedle: /correct the tenant.?s whatsapp/i,
    },
    {
      error_code: "partial_send" as const,
      reasonNeedle: /already delivered/i,
    },
  ])(
    "holds a $error_code Evolution failure for review instead of retrying",
    async ({ error_code, reasonNeedle }) => {
      // A logged-out QR session (or a half-sent multi-part message) is not
      // fixable by retry; retrying partial_send would resend delivered parts.
      db.pending = [
        row({
          id: `evo-${error_code}`,
          state: "failed",
          channel: "whatsapp",
          retry_count: 1,
          error_code,
        }),
      ];

      const result = await runNotificationDrainJob();

      expect(dispatchMock).not.toHaveBeenCalled();
      expect(result.retried).toEqual([]);
      expect(result.heldForReview).toBe(1);
      expect(db.updates[0].values).toEqual({
        state: "needs_review",
        failure_reason: EVOLUTION_NEEDS_REVIEW[error_code],
      });
      expect(String(db.updates[0].values.failure_reason)).toMatch(reasonNeedle);
    },
  );

  it("holds a timed-out send on a provider without an idempotency key for review", async () => {
    // Twilio, Meta and Evolution take no idempotency key: a timeout may mean the
    // tenant already has the message, so the drain's retry would send it twice.
    db.pending = [
      row({
        id: "timed-out",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: DELIVERY_INDETERMINATE,
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).not.toHaveBeenCalled();
    expect(result.heldForReview).toBe(1);
    expect(db.updates[0].values).toEqual({
      state: "needs_review",
      failure_reason: PROVIDER_NEEDS_REVIEW[DELIVERY_INDETERMINATE],
    });
  });

  it("still retries an Evolution unknown_error, which is transient by contract", async () => {
    db.pending = [
      row({
        id: "evo-transient",
        state: "failed",
        channel: "whatsapp",
        retry_count: 1,
        error_code: "unknown_error",
      }),
    ];

    const result = await runNotificationDrainJob();

    expect(retryMock).toHaveBeenCalledWith("evo-transient", 1);
    expect(result.retried).toEqual(["evo-transient"]);
    expect(result.heldForReview).toBe(0);
  });

  it("ignores asOf so a stray value cannot shift the drain window", async () => {
    db.pending = [row({ id: "due-1", scheduled_at: hoursAgo(1) })];

    const result = await runNotificationDrainJob("2020-01-01");

    expect(result.dispatched).toEqual(["due-1"]);
  });

  it.each(["pending", "published", "running"] as const)(
    "sends only the notification whose %s dispatch job is not in flight",
    async (status) => {
      // The request path enqueues `notification.dispatch` and returns, so the
      // row is still `queued` when the drain runs. Sending it here as well
      // would deliver the same message to the same recipient twice.
      db.pending = [row({ id: "in-flight-1" }), row({ id: "free-1" })];
      db.inFlightJobs = [
        {
          kind: "notification.dispatch",
          status,
          payload: { notificationId: "in-flight-1" },
          dedupe_key: "notification.dispatch:in-flight-1",
        },
      ];

      const result = await runNotificationDrainJob();

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenCalledWith("free-1");
      expect(result.dispatched).toEqual(["free-1"]);
      expect(result.skippedInFlight).toBe(1);
      expect(db.audit).toMatchObject({
        p_after: { scanned: 2, dispatched: 1, skipped_in_flight: 1 },
      });
    },
  );

  it.each(["succeeded", "failed", "skipped"] as const)(
    "dispatches a notification whose %s dispatch job is already finished",
    async (status) => {
      // A finished job left the row `queued` only when the handler could not
      // write the row's state, so the drain may take it over.
      db.pending = [row({ id: "finished-1" })];
      db.inFlightJobs = [
        {
          kind: "notification.dispatch",
          status,
          payload: { notificationId: "finished-1" },
          dedupe_key: "notification.dispatch:finished-1",
        },
      ];

      const result = await runNotificationDrainJob();

      expect(dispatchMock).toHaveBeenCalledWith("finished-1");
      expect(result.dispatched).toEqual(["finished-1"]);
      expect(result.skippedInFlight).toBe(0);
    },
  );

  it("selects the payload so a reverted query cannot hide an in-flight dispatch", async () => {
    // Without the payload the drain cannot tell which notification a job
    // belongs to, and it would send the row the worker is about to send.
    db.pending = [row({ id: "due-1" })];

    await runNotificationDrainJob();

    expect(db.jobRequestsSelect).toMatch(/\bpayload\b/);
  });

  it("ignores a dispatch job of another kind", async () => {
    db.pending = [row({ id: "other-kind-1" })];
    db.inFlightJobs = [
      {
        kind: "notification.bulk",
        status: "running",
        payload: { notificationId: "other-kind-1" },
        dedupe_key: "notification.bulk:other-kind-1",
      },
    ];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).toHaveBeenCalledWith("other-kind-1");
    expect(result.skippedInFlight).toBe(0);
  });

  it("ignores a job whose payload names another notification", async () => {
    // The payload is what the catalogue defines as the notification id, so a
    // row whose payload points elsewhere is not this notification's job.
    db.pending = [row({ id: "mine-1" })];
    db.inFlightJobs = [
      {
        kind: "notification.dispatch",
        status: "running",
        payload: { notificationId: "someone-else" },
        dedupe_key: "notification.dispatch:mine-1",
      },
    ];

    const result = await runNotificationDrainJob();

    expect(dispatchMock).toHaveBeenCalledWith("mine-1");
    expect(result.skippedInFlight).toBe(0);
  });
});
