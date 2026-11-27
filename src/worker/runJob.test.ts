import { describe, expect, test, vi } from "vitest";

import { MODULE_KEYS, type ModuleKey } from "@/company/modules";
import type { JobKind } from "@/jobs/catalog";

import {
  createRunJob,
  type HandlerLookup,
  type JobHandler,
  type JobNotice,
  type JobRequestRow,
  type JobRequestStatus,
  type RunJobPorts,
  type SkipReason,
} from "./runJob";
import type { JobAttempt } from "./types";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_ID = "66666666-6666-4666-8666-666666666666";

/** ما يراه الفاعل في صف الطلب بعد التنفيذ: الحالة والخطأ والنتيجة. */
interface RecordedRequest {
  status: JobRequestStatus;
  lastError: string | null;
  result: unknown;
  skipReason: SkipReason | null;
  attemptCount: number;
}

/** ما سجّله الوهمي منPorts: حالة الصف والإشعارات وعدد مرات تشغيل المعالج. */
interface FakeState {
  request: RecordedRequest;
  notices: JobNotice[];
  handlerRuns: number;
}

/** خيارات الوهمي: الصف وشركة الشركة والأقسام المفتوحة والمعالج. */
interface FakeOptions {
  row?: JobRequestRow | null;
  companyStatus?: "active" | "suspended";
  enabledSections?: ModuleKey[];
  handler?: JobHandler | null;
  /** كم مرة يفشل كتابة الإشعار قبل أن تنجح. */
  noticeFailures?: number;
}

/**
 * يبني ports وهمية فوق ذاكرة: الصف هو مصدر الحقيقة الوحيد الذي يرى الفاعل.
 */
function createFakePorts(options: FakeOptions = {}): {
  ports: RunJobPorts;
  handlerFor: HandlerLookup;
  state: FakeState;
} {
  const row = options.row ?? null;
  const state: FakeState = {
    request: {
      status: row?.status ?? "published",
      lastError: null,
      result: undefined,
      skipReason: null,
      attemptCount: 0,
    },
    notices: [],
    handlerRuns: 0,
  };
  let noticeFailuresLeft = options.noticeFailures ?? 0;

  const ports: RunJobPorts = {
    loadRequest: async (ref) =>
      row && row.id === ref.id && row.companyId === ref.companyId ? row : null,
    companyStatus: async () => options.companyStatus ?? "active",
    sectionEnabled: async (_companyId, section) =>
      (options.enabledSections ?? MODULE_KEYS).includes(section),
    markRunning: async (_ref, attempt) => {
      state.request.status = "running";
      state.request.attemptCount = attempt;
    },
    markSucceeded: async (_ref, result) => {
      state.request.status = "succeeded";
      state.request.result = result;
    },
    markFailed: async (_ref, lastError) => {
      state.request.status = "failed";
      state.request.lastError = lastError;
    },
    markSkipped: async (_ref, reason) => {
      state.request.status = "skipped";
      state.request.skipReason = reason;
    },
    writeNotice: async (notice) => {
      if (noticeFailuresLeft > 0) {
        noticeFailuresLeft -= 1;
        throw new Error("notice write failed");
      }
      state.notices.push(notice);
    },
  };

  const handlerFor: HandlerLookup = () => {
    const handler = options.handler;
    if (!handler) return undefined;
    return async (ctx) => {
      state.handlerRuns += 1;
      return handler(ctx);
    };
  };

  return { ports, handlerFor, state };
}

/**
 * يبني صف طلب مهمة بحمولة صالحة لنوعها.
 */
function requestRow(overrides: Partial<JobRequestRow> = {}): JobRequestRow {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    kind: "invoice.send",
    payload: payloadFor("invoice.send"),
    status: "published",
    requestedBy: STAFF_ID,
    ...overrides,
  };
}

/**
 * يعيد حمولة صالحة لنوع المهمة، لأن مخططات الكتالوج تشترط uuid.
 */
function payloadFor(kind: JobKind): unknown {
  switch (kind) {
    case "invoice.send":
      return { invoiceId: INVOICE_ID, channel: "email" };
    case "notification.bulk":
      return { requestId: REQUEST_ID };
    case "payment.settle":
      return { paymentRequestId: PAYMENT_REQUEST_ID };
    case "payment.succeeded":
      return { paymentId: PAYMENT_ID };
    default:
      throw new Error(`no payload prepared for ${kind}`);
  }
}

/**
 * يبني محاولة عامل كما يسلّمها BullMQ.
 */
function attemptFor(overrides: Partial<JobAttempt> = {}): JobAttempt {
  return {
    jobRequestId: REQUEST_ID,
    companyId: COMPANY_ID,
    kind: "invoice.send",
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

describe("runJob (T064)", () => {
  test.each(["succeeded", "skipped"] as const)(
    "a %s request is never run again",
    async (status) => {
      const { ports, handlerFor, state } = createFakePorts({ row: requestRow({ status }) });

      await createRunJob(ports, handlerFor)(attemptFor());

      expect(state.handlerRuns).toBe(0);
      expect(state.request.status).toBe(status);
      expect(state.notices).toEqual([]);
    },
  );

  test("a request that no longer exists fails loudly instead of running", async () => {
    const { ports, handlerFor, state } = createFakePorts({ row: null });

    await expect(createRunJob(ports, handlerFor)(attemptFor())).rejects.toThrow(REQUEST_ID);
    expect(state.handlerRuns).toBe(0);
    expect(state.notices).toEqual([]);
  });

  test("a row of another company is invisible to the worker", async () => {
    const { ports, handlerFor, state } = createFakePorts({ row: requestRow() });

    await expect(
      createRunJob(
        ports,
        handlerFor,
      )(attemptFor({ companyId: "99999999-9999-4999-8999-999999999999" })),
    ).rejects.toThrow(REQUEST_ID);
    expect(state.handlerRuns).toBe(0);
  });

  test("a suspended company skips the job instead of running it", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow(),
      companyStatus: "suspended",
      handler: async () => ({ sent: true }),
    });

    await createRunJob(ports, handlerFor)(attemptFor());

    expect(state.request.status).toBe("skipped");
    expect(state.request.skipReason).toBe("company_suspended");
    expect(state.handlerRuns).toBe(0);
  });

  test("payment.settle runs even while the company is suspended", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "payment.settle", payload: payloadFor("payment.settle") }),
      companyStatus: "suspended",
      handler: async () => ({ settled: true }),
    });

    await createRunJob(ports, handlerFor)(attemptFor({ kind: "payment.settle" }));

    expect(state.request.status).toBe("succeeded");
    expect(state.request.result).toEqual({ settled: true });
    expect(state.handlerRuns).toBe(1);
  });

  test("a switched-off section skips the job instead of running it and logs once", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow(),
      enabledSections: MODULE_KEYS.filter((key) => key !== "invoices"),
      handler: async () => ({ sent: true }),
    });

    await expect(createRunJob(ports, handlerFor)(attemptFor())).resolves.toBeUndefined();

    expect(state.request.status).toBe("skipped");
    expect(state.request.skipReason).toBe("module_disabled");
    expect(state.handlerRuns).toBe(0);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toContain("module_disabled");
    infoSpy.mockRestore();
  });

  test("a successful job records the handler result", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow(),
      handler: async () => ({ sent: true }),
    });

    await createRunJob(ports, handlerFor)(attemptFor({ attempt: 2 }));

    expect(state.request.status).toBe("succeeded");
    expect(state.request.result).toEqual({ sent: true });
    expect(state.request.attemptCount).toBe(2);
  });

  test.each([
    {
      label: "a kind that asks for a notice writes a success notice for its requester",
      kind: "notification.bulk" as const,
      requestedBy: STAFF_ID,
      expected: [
        {
          companyId: COMPANY_ID,
          userId: STAFF_ID,
          jobRequestId: REQUEST_ID,
          kind: "notification.bulk",
          level: "success",
        },
      ],
    },
    {
      label: "a kind that asks for no notice writes none",
      kind: "invoice.send" as const,
      requestedBy: STAFF_ID,
      expected: [],
    },
    {
      label: "a notice kind without a requester writes none",
      kind: "notification.bulk" as const,
      requestedBy: null,
      expected: [],
    },
  ])("$label", async ({ kind, requestedBy, expected }) => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind, payload: payloadFor(kind), requestedBy }),
      handler: async () => ({ done: true }),
    });

    await createRunJob(ports, handlerFor)(attemptFor({ kind }));

    expect(state.request.status).toBe("succeeded");
    expect(state.notices).toEqual(expected);
  });

  test.each([
    {
      label: "a result with all three counts carries them all in the notice body",
      result: { created: 3, skipped: 1, failed: 2, errors: ["row 3 refused"] },
      expected: { created: 3, skipped: 1, failed: 2 },
    },
    {
      label: "a result with one count carries just that count in the notice body",
      result: { created: 5 },
      expected: { created: 5 },
    },
    {
      label: "a result of zero counts carries them in the notice body",
      result: { created: 0, skipped: 0, failed: 0, errors: [] },
      expected: { created: 0, skipped: 0, failed: 0 },
    },
  ])("$label", async ({ result, expected }) => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "notification.bulk", payload: payloadFor("notification.bulk") }),
      handler: async () => result,
    });

    await createRunJob(ports, handlerFor)(attemptFor({ kind: "notification.bulk" }));

    expect(state.request.status).toBe("succeeded");
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].body).toEqual(expected);
  });

  test.each([
    { label: "a plain result", result: { sent: true } },
    {
      label: "a result whose counts are not numbers",
      result: { created: "3", skipped: "1", failed: "0" },
    },
    { label: "no result at all", result: null },
  ])("$label writes a notice with no body", async ({ result }) => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "notification.bulk", payload: payloadFor("notification.bulk") }),
      handler: async () => result,
    });

    await createRunJob(ports, handlerFor)(attemptFor({ kind: "notification.bulk" }));

    expect(state.request.status).toBe("succeeded");
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).not.toHaveProperty("body");
  });

  test("a notice that cannot be written leaves the job unfinished, and the retry writes one notice", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "notification.bulk", payload: payloadFor("notification.bulk") }),
      handler: async () => ({ created: 2, skipped: 0, failed: 0 }),
      noticeFailures: 1,
    });

    await expect(
      createRunJob(ports, handlerFor)(attemptFor({ kind: "notification.bulk" })),
    ).rejects.toThrow("notice write failed");
    // The status is written after the notice, so a notice that failed leaves
    // the row for the retry instead of ending the job without telling anyone.
    expect(state.request.status).toBe("running");
    expect(state.notices).toEqual([]);

    await createRunJob(ports, handlerFor)(attemptFor({ kind: "notification.bulk" }));

    expect(state.request.status).toBe("succeeded");
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0].body).toEqual({ created: 2, skipped: 0, failed: 0 });
  });

  test("a handler failure before the last attempt leaves the job for a retry", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow(),
      handler: async () => {
        throw new Error("gateway timeout");
      },
    });

    await expect(
      createRunJob(ports, handlerFor)(attemptFor({ attempt: 1, maxAttempts: 3 })),
    ).rejects.toThrow("gateway timeout");
    expect(state.request.status).toBe("running");
    expect(state.notices).toEqual([]);
  });

  test("a handler failure on the last attempt fails the job and tells the requester", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "notification.bulk", payload: payloadFor("notification.bulk") }),
      handler: async () => {
        throw new Error("gateway timeout");
      },
    });

    await expect(
      createRunJob(
        ports,
        handlerFor,
      )(attemptFor({ kind: "notification.bulk", attempt: 3, maxAttempts: 3 })),
    ).rejects.toThrow("gateway timeout");
    expect(state.request.status).toBe("failed");
    expect(state.request.lastError).toBe("gateway timeout");
    expect(state.notices).toEqual([
      {
        companyId: COMPANY_ID,
        userId: STAFF_ID,
        jobRequestId: REQUEST_ID,
        kind: "notification.bulk",
        level: "error",
      },
    ]);
  });

  test("an invalid payload fails the job without running the handler", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ payload: { invoiceId: "not-a-uuid", channel: "email" } }),
      handler: async () => ({ sent: true }),
    });

    await expect(createRunJob(ports, handlerFor)(attemptFor())).resolves.toBeUndefined();
    expect(state.request.status).toBe("failed");
    expect(state.request.lastError).toContain("invalid payload for invoice.send");
    expect(state.handlerRuns).toBe(0);
  });

  test.each([
    { kind: "invoice.send" as const, label: "a catalogue kind" },
    { kind: "payment.succeeded" as const, label: "a money event with no handler yet" },
  ])("$label with no registered handler fails the job permanently", async ({ kind }) => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind, payload: payloadFor(kind) }),
    });

    await expect(createRunJob(ports, handlerFor)(attemptFor({ kind }))).resolves.toBeUndefined();
    expect(state.request.status).toBe("failed");
    expect(state.request.lastError).toBe(`no handler for ${kind}`);
    expect(state.handlerRuns).toBe(0);
  });

  test("a row whose kind this build does not know fails instead of staying published", async () => {
    const { ports, handlerFor, state } = createFakePorts({
      row: requestRow({ kind: "invoice.teleport" }),
    });

    await expect(createRunJob(ports, handlerFor)(attemptFor())).resolves.toBeUndefined();
    expect(state.request.status).toBe("failed");
    expect(state.request.lastError).toBe("unknown job kind: invoice.teleport");
    expect(state.handlerRuns).toBe(0);
  });
});
