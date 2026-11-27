import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * اختبارات تكرار تنفيذ المعالجات: مهمة أُعيدت بعد أن أدّت عملها يجب أن تترك
 * أثراً خارجياً واحداً — رسالة واحدة، وصف إشعار واحد، ومهمة إرسال واحدة.
 *
 * The contract states it plainly (contracts/jobs.md section 3): running a
 * handler twice for the same `jobRequestId` produces the same state and no
 * second message, document or record. BullMQ retries a job that died after
 * doing its work, and the relay republishes a row whose publish went stale,
 * so a handler that is not idempotent sends twice.
 *
 * Only the boundaries are faked: the database, the storage and the provider's
 * HTTP call. The handlers, the notification sender and the templates all run
 * untouched, so what a test asserts is what the tenant would have received.
 */
vi.mock("@tanstack/react-start", async () =>
  (await import("@/fns/dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/fns/evolutionSessionWatch", () => ({ reportSendSessionDisconnected: vi.fn() }));
vi.mock("@/company/companyClient.server", async () =>
  (await import("./idempotency.testkit")).companyClientModule(),
);
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./idempotency.testkit")).requestCompanyModule(),
);
// The PDF renderers shell out to a headless Chromium and upload the file they
// produce. The document is a system boundary here, not the subject of these
// tests: what matters is how many notifications and sends a retry leaves
// behind, not how many pages the attachment had.
vi.mock("@/lib/invoiceDocumentPdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoiceDocumentPdf")>()),
  renderInvoiceDocumentPdf: async () => null,
}));
vi.mock("@/lib/paymentReceiptPdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paymentReceiptPdf")>()),
  renderPaymentReceiptPdfs: async () => [],
}));
vi.mock("@/lib/reportPdfAttachment", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reportPdfAttachment")>();
  const kit = await import("./idempotency.testkit");
  return {
    ...original,
    renderAndStorePdf: async (input: {
      companyId?: string;
      discriminator: string;
      name: string;
      prefix: string;
    }) => {
      const path = `companies/${kit.COMPANY_ID}/${input.prefix}/${input.name}-${input.discriminator}.pdf`;
      kit.storeObject("report-documents", path);
      return { bucket: "report-documents", path };
    },
  };
});

import { resetDispatchFixtures, restoreDispatchFixtures } from "@/fns/dispatchNotification.testkit";
import { notificationDispatchDedupeKey } from "@/jobs/catalog";
import { createCronHandlers } from "@/jobs/handlers/cron";
import { createCompanyInfoSendHandler } from "@/jobs/handlers/documentsCompanyInfo";
import { createInvoiceSendHandler } from "@/jobs/handlers/documentsInvoice";
import { createPaymentReceiptHandler } from "@/jobs/handlers/documentsPayment";
import { createReportRunHandler } from "@/jobs/handlers/documentsReport";
import { createNotificationDispatchHandler } from "@/jobs/handlers/notification";
import {
  COMPANY_ID,
  enqueuedJobCalls,
  INVOICE_ID,
  NOTIFICATION_ID,
  PAYMENT_ID,
  REPORT_DATE,
  resetDatabase,
  rowsOf,
  SCHEDULE_ID,
  seedNotification,
  TENANT_ID,
} from "@/jobs/handlers/idempotency.testkit";

/**
 * ما يرسله العامل إلى المعالج: الحمولة محقّقة مسبقاً بمخطط الكتالوج.
 *
 * The same context is handed to the handler twice in every test: that is what
 * a BullMQ retry of one job looks like from inside the handler.
 */
function jobContext(payload: unknown) {
  return {
    jobRequestId: "99999999-9999-4999-8999-999999999999",
    companyId: COMPANY_ID,
    payload,
    attempt: 1,
  };
}

/**
 * رد المزوّد الذي قبِل الرسالة.
 *
 * A factory, not a value: a `Response` body can be read once, so handing the
 * same instance to a second send would fail on the read instead of on the
 * provider.
 */
function acceptedByProvider(): Response {
  return new Response(JSON.stringify({ id: "resend-1" }), { status: 200 });
}

/** رد المزوّد الذي رفض الرسالة. */
function refusedByProvider(): Response {
  return new Response(JSON.stringify({ message: "provider refused" }), { status: 500 });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The provider's HTTP call and its secrets are the boundary the dispatch
  // tests share with the rest of the repository.
  resetDispatchFixtures();
  resetDatabase();
});
afterEach(restoreDispatchFixtures);

describe("the notification.dispatch handler", () => {
  test("a retry after a delivered notification does not reach the provider again", async () => {
    seedNotification();
    const provider = vi.mocked(globalThis.fetch);
    provider.mockImplementation(async () => acceptedByProvider());
    const handler = createNotificationDispatchHandler({ pace: vi.fn() });
    const context = jobContext({ notificationId: NOTIFICATION_ID });

    const first = await handler(context);
    const second = await handler(context);

    // The row's own state is the marker: a row that already went out is
    // returned as it is, and no provider sees it again.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
    expect(second).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
  });

  test("a retry after the provider refused repeats the provider idempotency key", async () => {
    seedNotification();
    const provider = vi.mocked(globalThis.fetch);
    provider
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(async () => acceptedByProvider());
    const handler = createNotificationDispatchHandler({ pace: vi.fn() });
    const context = jobContext({ notificationId: NOTIFICATION_ID });

    const first = await handler(context);
    const second = await handler(context);

    expect(first).toEqual({ notificationId: NOTIFICATION_ID, state: "failed" });
    expect(second).toEqual({ notificationId: NOTIFICATION_ID, state: "sent" });
    // A row that failed carries no marker of its own, so the provider is the
    // one that keeps the retry from delivering twice: the key is derived from
    // the row id and the unchanged body, and Resend answers a reused key with
    // the first message instead of sending a second one.
    const keys = provider.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"],
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("the company.info.send handler", () => {
  test("a retry of the same job must not queue a second copy of the document", async () => {
    // BUG: the handler writes one notification row per run and queues one
    // dispatch job per row, and nothing records that this document already
    // went out for this tenant today. The catalogue's dedupe key belongs to
    // the job row, not to the notification, so it cannot stop the second copy:
    // a worker that dies after the rows are written retries the job and the
    // tenant receives the company information twice.
    //
    // A retry also re-claims the reused row's dispatch (GR-003), so the marker
    // is the outbox's own guarantee: every claim carries the same dedupe key
    // and `enqueue_job` folds them onto one job (`on conflict do nothing`).
    const handler = createCompanyInfoSendHandler();
    const context = jobContext({
      tenantId: TENANT_ID,
      channels: ["email"],
      language: "ar",
    });

    await handler(context);
    await handler(context);

    expect(rowsOf("notifications")).toHaveLength(1);
    const dispatchKeys = new Set(enqueuedJobCalls().map((call) => String(call._dedupe_key)));
    expect(dispatchKeys).toEqual(
      new Set([notificationDispatchDedupeKey(String(rowsOf("notifications")[0].id))]),
    );
  });
});

describe("the invoice.send handler", () => {
  test("a retry of the same job must not queue a second copy of the invoice", async () => {
    // BUG: the invoice row is written without a delivery key on purpose — an
    // admin may resend the same invoice as many times as they like — and that
    // leaves the job path without a marker: a retried job writes a second row
    // and the tenant is sent the invoice twice.
    //
    // A retry also re-claims the reused row's dispatch (GR-003), so the marker
    // is the outbox's own guarantee: every claim carries the same dedupe key
    // and `enqueue_job` folds them onto one job (`on conflict do nothing`).
    const handler = createInvoiceSendHandler();
    const context = jobContext({ invoiceId: INVOICE_ID, channel: "email" });

    await handler(context);
    await handler(context);

    expect(rowsOf("notifications")).toHaveLength(1);
    const dispatchKeys = new Set(enqueuedJobCalls().map((call) => String(call._dedupe_key)));
    expect(dispatchKeys).toEqual(
      new Set([notificationDispatchDedupeKey(String(rowsOf("notifications")[0].id))]),
    );
  });
});

describe("the payment.receipt handler", () => {
  test("a retry of the same payment does not queue a second receipt", async () => {
    // The receipt is the one document family that carries its own marker: the
    // handler scans the notifications it wrote for the same payment ids and
    // reports them instead of writing them again.
    const handler = createPaymentReceiptHandler();
    const context = jobContext({ paymentId: PAYMENT_ID, workflow: "payment-succeeded" });

    const first = await handler(context);
    const rowsAfterFirst = rowsOf("notifications").length;
    const jobsAfterFirst = enqueuedJobCalls().length;
    const second = await handler(context);

    expect(first).toMatchObject({ ok: true, skipped: false });
    expect(second).toMatchObject({ ok: true, skipped: true });
    expect(rowsAfterFirst).toBeGreaterThan(0);
    expect(rowsOf("notifications")).toHaveLength(rowsAfterFirst);
    expect(enqueuedJobCalls()).toHaveLength(jobsAfterFirst);
  });
});

describe("the cron handler family", () => {
  test("a repeated run does the work again, because the fan-out's key is the guard", async () => {
    // The cron kinds are the one family that does not claim idempotency at the
    // handler, and deliberately so: the fan-out writes one job row per company
    // under a deterministic key, so a second fan-out is impossible, while a
    // retry of a failed job has to do its work again. A claim inside the
    // handler would only stop that retry.
    //
    // The work is injected through the factory — the same seam
    // `createRunJob(ports, handlerFor)` uses — so what is asserted is the
    // handler's own behaviour, not the SQL each job function happens to call.
    const work = vi.fn(async (_asOf: string | null, _companyId: string) => ({ done: true }));
    const handler = createCronHandlers({
      "overdue.evaluate": { registryKey: "overdue", work },
    })["overdue.evaluate"];
    const context = jobContext({ date: REPORT_DATE });

    await handler?.(context);
    await handler?.(context);

    expect(work).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledWith(REPORT_DATE, COMPANY_ID);
  });
});

describe("the report.run handler", () => {
  test("a retry after the provider refused generates the report once and delivers it once", async () => {
    // The stored report is the marker: the second run finds it and sends that
    // one instead of building the report again. With `failed` inside the
    // delivery index (migration 312) the retry re-queues the very row the
    // failed attempt wrote and dispatches it again — one row per job and
    // channel on the log, not a fresh row per attempt.
    let attempt = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      attempt += 1;
      return attempt === 1 ? refusedByProvider() : acceptedByProvider();
    });
    const handler = createReportRunHandler();
    const context = jobContext({ scheduleId: SCHEDULE_ID, date: REPORT_DATE });

    await handler(context);
    await handler(context);

    expect(rowsOf("generated_reports")).toHaveLength(1);
    const notifications = rowsOf("notifications");
    // صف تسليم واحد فقط، وهو المُرسَل: إعادة المحاولة أعادت صف المحاولة
    // الفاشلة إلى الطابور وصرّفته، فلم يبقَ صف فاشل بجوار صف مُرسَل.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ state: "sent" });
  });

  test("a retry after a delivered report must not send the report again", async () => {
    // BUG: a report already stored for that schedule and period is read as
    // "the admin asked for it again" — the handler inserts a second
    // notification row and sends it. A worker that dies after sending but
    // before the job is marked done retries the job, and the recipient reads
    // the same report twice.
    vi.mocked(globalThis.fetch).mockImplementation(async () => acceptedByProvider());
    const handler = createReportRunHandler();
    const context = jobContext({ scheduleId: SCHEDULE_ID, date: REPORT_DATE });

    await handler(context);
    await handler(context);

    expect(rowsOf("notifications").filter((row) => row.state === "sent")).toHaveLength(1);
  });
});
