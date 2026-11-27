/**
 * عدّة اختبار مشتركة لاختبارات أحداث المال: صفوف الكيانات، وعلامات الإرسال،
 * وحقن أعطال حدود الإرسال.
 *
 * Only the database is faked — the handlers and their senders run untouched,
 * so what a test asserts is what the admin or renter would have received. The
 * failure switches bend that one boundary (an insert refusal, an outbox
 * refusal) so a handler is *seen* failing a send; no sender or helper is ever
 * mocked. Shared by `events.test.ts` and `events.sendoutcomes.test.ts`, the
 * same way `idempotency.testkit.ts` serves the retry tests.
 */

import type { JobHandlerContext } from "@/worker/runJob";

import {
  companyClientModule,
  enqueuedJobCalls,
  rowsOf,
  COMPANY_ID,
  TENANT_ID,
} from "./idempotency.testkit";

export const JOB_REQUEST_ID = "8abcabc1-1111-4111-8111-111111111111";

/**
 * معرّفات كيانات أحداث المال: معرّفات صالحة تمرّ على مخطط الحمولة الصارم.
 */
export const PAYMENT_ID = "a1111111-1111-4111-8111-111111111111";
export const DEPOSIT_ID = "b2222222-2222-4222-8222-222222222222";
export const REFUND_ID = "c3333333-3333-4333-8333-333333333333";
export const WRITE_OFF_INVOICE_ID = "d4444444-4444-4444-8444-444444444444";
export const DISPUTED_INVOICE_ID = "e5555555-5555-4555-8555-555555555555";
export const CLOSEOUT_ID = "f6666666-6666-4666-8666-666666666666";
export const CONTRACT_ID = "07777777-7777-4777-8777-777777777777";
export const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";

/**
 * أعطال حدود الإرسال المحقونة: رفض إدراج الإشعارات، وتعطّل صندوق المهام.
 *
 * The senders run their real code against the fake database; these switches
 * make that boundary fail so a handler is seen failing a send.
 */
export const injectedFailures = {
  enqueueJob: false,
  notificationInsert: false,
};

/** يقطع أعطال الحقن — يُستدعى قبل كل اختبار. */
export function resetInjectedFailures(): void {
  injectedFailures.enqueueJob = false;
  injectedFailures.notificationInsert = false;
}

/**
 * مصنع `vi.mock("@/company/companyClient.server", …)` مع حقن أعطال الإرسال.
 *
 * The wrapper only replaces `notifications` inserts and `enqueue_job` calls
 * when the matching switch is on; every other query is the plain fake client.
 */
export function companyClientModuleWithSendFailures() {
  const base = companyClientModule();
  return {
    ...base,
    companyClient: (companyId: string) => {
      const client = base.companyClient(companyId);
      return {
        ...client,
        from: (table: string) => {
          const chain = client.from(table);
          if (table === "notifications" && injectedFailures.notificationInsert) {
            chain.insert = () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { message: "injected: notifications insert refused", code: "08006" },
                }),
              }),
            });
          }
          return chain;
        },
        rpc: (name: string, args: Record<string, unknown>) =>
          name === "enqueue_job" && injectedFailures.enqueueJob
            ? { data: null, error: { message: "injected: outbox refused" } }
            : client.rpc(name, args),
      };
    },
  };
}

/** عميل العدّة غير المقيَّد بأنواعها: الجداول المزروعة تُنشأ بإدراج صف فيه. */
const seedClient = companyClientModule().companyClient(COMPANY_ID);

/** يزرع صفاً في جدول العدّة الوهمي. */
export async function seedRow(table: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await seedClient.from(table).insert(values);
  if (error) throw new Error(error.message);
}

/** يزرع صف دفعة مؤكَّدة يحمله حدثا `payment.succeeded` و`payment.reversed`. */
export function seedPayment(companyId: string): Promise<void> {
  return seedRow("payments", {
    id: PAYMENT_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    status: "confirmed",
    amount: 200,
    currency: "KWD",
    code: "PAY-1",
    method: "cash",
    payment_date: "2026-11-01",
    reference: "REF-1",
  });
}

/**
 * يزرع دفعة تسوية إغلاق عقد: مرجعها هو علامة كتّاب الإغلاق (GR-004).
 */
export function seedCloseOutSettlementPayment(companyId: string): Promise<void> {
  return seedRow("payments", {
    id: PAYMENT_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    status: "confirmed",
    amount: 200,
    currency: "KWD",
    code: "PAY-CLOSEOUT",
    method: "cash",
    payment_date: "2026-11-30",
    reference: "CLOSEOUT:CT-1",
  });
}

/** يزرع صف إيداع بحالته — المؤكَّد يحمله الحدث، وغير المؤكَّد تخطٍّ مقصود. */
export function seedDeposit(companyId: string, status: "confirmed" | "pending"): Promise<void> {
  return seedRow("deposits", {
    id: DEPOSIT_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    status,
    amount: 25,
    currency: "KWD",
    bank_name: "NBK",
    deposit_date: "2026-11-01",
    code: "DEP-1",
    note: null,
    attachment_path: null,
  });
}

/** يزرع صف استرداد يحمله حدث `refund.recorded`. */
export function seedRefund(companyId: string): Promise<void> {
  return seedRow("refunds", {
    id: REFUND_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    amount: 50,
    currency: "KWD",
    reason: "damage",
    note: null,
  });
}

/** يزرع الفاتورة وصف الحدث الذي كتبه الشطب؛ سبب الشطب يعيش في الحدث التشغيلي. */
export async function seedWrittenOffInvoice(companyId: string): Promise<void> {
  await seedRow("invoices", {
    id: WRITE_OFF_INVOICE_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    contract_id: CONTRACT_ID,
    code: "INV-W",
    total: 75,
    paid: 0,
    balance: 75,
  });
  await seedRow("contract_operational_events", {
    company_id: companyId,
    contract_id: CONTRACT_ID,
    tenant_id: TENANT_ID,
    event_type: "invoice_written_off",
    payload: { invoice_id: WRITE_OFF_INVOICE_ID, balance_written_off: 75 },
    note: "broken meter",
  });
}

/** يزرع صف فاتورة متنازع عليها؛ سبب النزاع على الفاتورة نفسها يقرأه المُرسِل. */
export function seedDisputedInvoice(companyId: string): Promise<void> {
  return seedRow("invoices", {
    id: DISPUTED_INVOICE_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    contract_id: CONTRACT_ID,
    code: "INV-D",
    total: 120,
    paid: 0,
    balance: 120,
    dispute_reason: "over charged",
  });
}

/** يزرع صف إغلاق عقد يحمله حدث `contract.closed_out`. */
export function seedCloseOut(companyId: string): Promise<void> {
  return seedRow("contract_closeouts", {
    id: CLOSEOUT_ID,
    company_id: companyId,
    contract_id: CONTRACT_ID,
    tenant_id: TENANT_ID,
    outcome: "archive",
    move_out_date: "2026-11-30",
    refund_total: 0,
    balance_due_tenant: 0,
  });
}

/** يزرع العقد وصف حدث الاستعادة: الحالة والسبب في الحدث التشغيلي. */
export async function seedRestoredContract(companyId: string): Promise<void> {
  await seedRow("contracts", {
    id: CONTRACT_ID,
    company_id: companyId,
    tenant_id: TENANT_ID,
    code: "CT-1",
  });
  await seedRow("contract_operational_events", {
    company_id: companyId,
    contract_id: CONTRACT_ID,
    tenant_id: TENANT_ID,
    event_type: "restored",
    payload: { contract_id: CONTRACT_ID, contract_state: "active", reason: "tenant returning" },
    note: "tenant returning",
  });
}

/**
 * يزرع علامة «أُبلغ سابقاً»: صف إشعار قديم لنوع الحدث وحمولته.
 *
 * The senders' idempotency check reads exactly this shape — the type plus the
 * payload match — so the seeded row makes the sender report its deliberate
 * `Already notified.` skip.
 */
export async function seedAlreadyNotified(
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await seedRow("notifications", {
    type,
    payload,
    audience: "admin",
    channel: "email",
    state: "sent",
    body: "earlier notice",
    subject: "earlier notice",
  });
}

/**
 * علامات الإرسال المرئية: صفوف الإشعار المكتوبة، وأعمال المخرجات المطلوبة.
 *
 * The outbox collapses a repeated `(kind, dedupe key)` request onto the job
 * that already exists (contracts/jobs.md section 1), so receipt requests are
 * counted per distinct key: a retry that repeats one key requests no new work
 * and therefore sends nothing.
 */
export function sentMarkers(): string[] {
  const rows = rowsOf("notifications").map((row) => `notification:${String(row.id)}`);
  const work = new Set(
    enqueuedJobCalls()
      .filter((call) => call._kind === "payment.receipt")
      .map((call) => `job:payment.receipt:${String(call._dedupe_key)}`),
  );
  return [...rows, ...work].sort();
}

/** ما يراه المعالج من العامل: الحمولة نفسها كما أقرّها الكتالوج. */
export function contextFor(scenario: { payload: Record<string, string> }): JobHandlerContext {
  return {
    jobRequestId: JOB_REQUEST_ID,
    companyId: COMPANY_ID,
    payload: scenario.payload,
    attempt: 1,
  };
}
