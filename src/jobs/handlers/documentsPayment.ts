import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import {
  missingPdfPayload,
  paymentNotifyOutcome,
  paymentsMissingPdf,
  type PaymentNotifyResult,
} from "@/fns/paymentNotifyResult";
import { templateAllowsChannel } from "@/fns/templateChannelPolicy";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import type { Database } from "@/integrations/supabase/database.types";
import type { JobPayload } from "@/jobs/catalog";
import {
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
  renderEmailDocument,
  type EmailLocale,
} from "@/lib/emailTemplates";
import { formatMonthYear } from "@/lib/dateDisplay";
import { formatKwd } from "@/lib/money";
import { formatPaymentMethod } from "@/lib/paymentMethodDisplay";
import { renderPaymentReceiptPdfs } from "@/lib/paymentReceiptPdf";
import { attachmentPayload } from "@/lib/reportPdfAttachment";
import { getSuppressedPaymentIds } from "@/lib/suppressedPayments";
import { stripMarkup } from "@/lib/templateRender";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";
import { translatorFor } from "@/i18n/dictionary";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * يحوّل قيمة سبب السداد اليدوي من قائمة الخيارات إلى تسميتها المعروضة للقارئ ضمن الشركة.
 */
async function resolveManualPaymentReasonLabel(
  db: SupabaseClient<Database>,
  value: string,
  locale: EmailLocale,
): Promise<string> {
  try {
    for (const code of ["payment_methods", "manual_payment_reasons"]) {
      const item = await db
        .from("option_list_items")
        .select("label_ar, label_en, option_lists!inner(code)")
        .eq("option_lists.code", code)
        .eq("value", value)
        .maybeSingle();
      if (item.error || !item.data) continue;
      return (locale === "ar" ? item.data.label_ar : item.data.label_en) || value;
    }
    return value;
  } catch {
    return value;
  }
}

/**
 * يبني إشعارات الإدارة والمستأجر بالبريد وواتساب بعد تأكيد دفعة أو أكثر ضمن نطاق الشركة.
 *
 * The work moved out of the request so a receipt never waits on a Chromium
 * render: the request enqueues one `payment.receipt` job per payment and this
 * function is what that job runs (contracts/jobs.md section 3).
 *
 * The idempotency scan below is what makes a second run for the same payment a
 * no-op: a receipt already queued for these payments is not queued again.
 */
export async function sendPaymentReceipts(
  paymentIds: string[],
  targets: WorkflowRecipientTarget[],
  companyId: string,
): Promise<PaymentNotifyResult> {
  const uniqueIds = [...new Set(paymentIds.filter(Boolean))];
  if (!uniqueIds.length) {
    return { ok: false as const, nothingToDo: true as const, error: "No payment ids." };
  }

  try {
    const db = companyClient(companyId);
    const paymentsResult = await db
      .from("payments")
      .select("*")
      .in("id", uniqueIds)
      .eq("status", "confirmed");
    if (paymentsResult.error) throw new Error(paymentsResult.error.message);
    const payments = paymentsResult.data;
    if (!payments.length) {
      return { ok: false as const, nothingToDo: true as const, error: "No confirmed payments." };
    }

    const sortedIds = payments
      .map((payment) => payment.id)
      .sort()
      .join(",");
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sortedIds),
    );
    const deliverySet = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    const tenantId = payments[0].tenant_id;
    const tenantResult = await db.from("tenants").select("*").eq("id", tenantId).single();
    if (tenantResult.error) throw new Error(tenantResult.error.message);
    const tenant = tenantResult.data;
    const locale = (tenant.preferred_language ?? "ar") as EmailLocale;

    const allocations = await db
      .from("payment_allocations")
      .select("payment_id, invoice_id, amount")
      .in("payment_id", uniqueIds);
    if (allocations.error) throw new Error(allocations.error.message);

    const invoiceIds = [...new Set(allocations.data.map((row) => row.invoice_id))];
    const invoices = invoiceIds.length
      ? await db
          .from("invoices")
          .select(
            "id, code, period_month, period_year, total, balance, manual_payment_reason, contract_id",
          )
          .in("id", invoiceIds)
      : { data: [], error: null };
    if (invoices.error) throw new Error(invoices.error.message);

    let suppressedPaymentIds = new Set<string>();
    let suppressionResolved = true;
    try {
      suppressedPaymentIds = await getSuppressedPaymentIds(uniqueIds, companyId);
    } catch (error) {
      console.error(
        "[notifyPaymentSuccess] failed to resolve suppressed contracts; suppressing the tenant notification",
        error instanceof Error ? error.message : String(error),
      );
      suppressionResolved = false;
    }

    const tenantReceiptPayments = suppressionResolved
      ? payments.filter((payment) => !suppressedPaymentIds.has(payment.id))
      : [];
    const tenantSuppressed = tenantReceiptPayments.length === 0;

    const periods = (invoices.data ?? [])
      .map((invoice) => formatMonthYear(invoice.period_month, invoice.period_year, locale))
      .join(", ");
    const reasonValue =
      (invoices.data ?? []).map((invoice) => invoice.manual_payment_reason).find(Boolean) ?? null;
    const manualPaymentReason = reasonValue
      ? await resolveManualPaymentReasonLabel(db, reasonValue, locale)
      : null;

    const totalAmount = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    const amountLabel = formatKwd(totalAmount, locale);
    const paymentCodes = payments.map((payment) => payment.code).join(", ");
    const translate = translatorFor(locale);
    const paymentMethod = [
      ...new Set(payments.map((payment) => formatPaymentMethod(payment.method, translate))),
    ].join(", ");
    const reference = payments.map((payment) => payment.reference ?? payment.code).join(", ");

    const primaryId = payments[0].id;
    const existing = await db
      .from("notifications")
      .select("id, payload")
      .in("type", ["receipt", "payment_admin_alert"])
      .neq("state", "cancelled")
      .eq("tenant_id", tenantId)
      .contains("payload", { payment_ids: uniqueIds });
    if (!existing.error && existing.data?.length) {
      const wanted = new Set(uniqueIds);
      const matches = existing.data.filter((row) => {
        const payload = row.payload;
        if (!payload || Array.isArray(payload) || typeof payload !== "object") return false;
        const ids = payload.payment_ids;
        if (!Array.isArray(ids)) return false;
        const set = new Set(ids.filter((id): id is string => typeof id === "string"));
        if (set.size !== wanted.size) return false;
        for (const id of wanted) if (!set.has(id)) return false;
        return true;
      });
      if (matches.length) {
        return { ok: true as const, skipped: true, ids: matches.map((r) => r.id) };
      }
    }

    const results: string[] = [];

    // Admin/company are address-level: filter inside one block. Do NOT gate this
    // block on targets.includes("admin") — that would kill company-only sends.
    const adminEmails = await resolveNotificationRecipients(targets, companyId);
    // Tenant is block-level: off suppresses email AND WhatsApp. A suppressed
    // roof payment suppresses the tenant block entirely — no email, no WhatsApp,
    // and no PDF rendered solely for them (see the render condition below which
    // already avoids Chromium when nobody receives it).
    // Payment receipts are transactional proof of payment, not proactive
    // reminders (`PROACTIVE_REMINDER_TYPES`), so `reminders_enabled` does not
    // gate WhatsApp here; `tenant.notifications_paused` still applies in `enqueueNotification`.
    const waNumber = tenant.whatsapp ?? tenant.mobile;
    const needsReceipt =
      !tenantSuppressed &&
      targets.includes("tenant") &&
      (Boolean(tenant.email) || Boolean(waNumber));

    // Rendered after both the idempotency check and the recipient resolution,
    // because both decide whether anyone receives this at all. A duplicate
    // notify, a workflow aimed at an admin address that is not configured, a
    // tenant with neither an email nor a WhatsApp number, or a payment whose
    // invoices are all on suppressed contracts, would otherwise each spawn a
    // Chromium process and write a storage object for a mail nobody gets.
    //
    // One render serves both audiences — the tenant's receipt and the admin
    // alert reference the same stored object, so an admin asked "what did the
    // tenant actually get?" is holding it. When the tenant is suppressed but an
    // admin still receives it, the PDF is still rendered for the admin alone.
    // The admin copy covers every payment; the tenant's covers only the ones
    // they may be issued paper for. In the ordinary case those are the same set
    // and one render serves both, which is what keeps "an admin asked what the
    // tenant got is holding it" true. They diverge only for a mixed batch.
    const adminReceiptPdfs = adminEmails.length
      ? await renderPaymentReceiptPdfs({ locale, manualPaymentReason, payments })
      : [];
    const tenantReceiptPdfs = !needsReceipt
      ? []
      : tenantReceiptPayments.length === payments.length && adminReceiptPdfs.length
        ? adminReceiptPdfs
        : await renderPaymentReceiptPdfs({
            locale,
            manualPaymentReason,
            payments: tenantReceiptPayments,
          });
    const adminReceiptAttachments = attachmentPayload(
      adminReceiptPdfs,
      adminReceiptPdfs.map((document) => document.displayName),
    );
    const receiptPdfs = tenantReceiptPdfs;
    const adminMissingPdfs = adminEmails.length
      ? paymentsMissingPdf(payments, adminReceiptPdfs)
      : [];
    const tenantMissingPdfs = needsReceipt
      ? paymentsMissingPdf(tenantReceiptPayments, tenantReceiptPdfs)
      : [];
    const missingPdfs = [...new Set([...adminMissingPdfs, ...tenantMissingPdfs])];
    if (missingPdfs.length) {
      console.error("[notifyPaymentSuccess] receipt PDF missing; sending without it", missingPdfs);
    }
    const receiptAttachments = attachmentPayload(
      tenantReceiptPdfs,
      tenantReceiptPdfs.map((document) => document.displayName),
    );
    // The same documents under keys nothing dispatches on — see the WhatsApp
    // payload below. Empty when there is no PDF, so the row never claims one.
    const receiptRecord = receiptPdfs.length
      ? {
          receipt_pdf_bucket: receiptPdfs[0].bucket,
          receipt_pdf_paths: receiptPdfs.map((document) => document.path),
        }
      : {};

    if (adminEmails.length) {
      const adminVars = {
        tenant_name: tenant.name,
        amount: amountLabel,
        periods: periods || "—",
        payment_codes: paymentCodes,
        payment_method: paymentMethod,
        manual_payment_reason: manualPaymentReason ?? "",
      };
      const adminCode = "payment-admin-alert";
      const adminCopy = await loadTemplateCopy(adminCode, locale, adminVars);
      const adminBuiltIn = paymentAdminAlertTemplate({
        locale,
        tenantName: tenant.name,
        amount: amountLabel,
        periods: periods || "—",
        paymentCodes,
        paymentMethod,
        manualPaymentReason,
      });
      const adminSubject = adminCopy.subject ?? adminBuiltIn.subject;
      const adminBody = adminCopy.body
        ? renderEmailDocument(locale, adminSubject, adminCopy.body)
        : adminBuiltIn.html;
      const adminNote = await enqueueNotification({
        type: "payment_admin_alert",
        channel: "email",
        audience: "admin",
        companyId,
        locale,
        tenantId: tenant.id,
        subject: adminSubject,
        body: adminBody,
        recipientAddress: adminEmails[0],
        templateCode: adminCode,
        deliveryKey: `payment_admin_alert:email:${deliverySet}`,
        payload: {
          recipients: adminEmails,
          payment_ids: uniqueIds,
          periods,
          amount: amountLabel,
          ...adminReceiptAttachments,
          ...missingPdfPayload(adminMissingPdfs),
        },
      });
      if (adminNote) results.push(adminNote.id);
    }

    if (needsReceipt) {
      const receiptVars = {
        tenant_name: tenant.name,
        amount: amountLabel,
        payment_date: payments[0].payment_date,
        reference,
        manual_payment_reason: manualPaymentReason ?? "",
      };
      const receiptCode = "receipt";
      const receiptCopy = await loadTemplateCopy(receiptCode, locale, receiptVars);
      const receiptBuiltIn = paymentReceiptTemplate({
        locale,
        tenantName: tenant.name,
        amount: amountLabel,
        paymentDate: payments[0].payment_date,
        reference,
        manualPaymentReason,
      });
      const receiptSubject = receiptCopy.subject ?? receiptBuiltIn.subject;
      const receiptBody = receiptCopy.body
        ? renderEmailDocument(locale, receiptSubject, receiptCopy.body)
        : receiptBuiltIn.html;

      // `receipt` and `payment-admin-alert` are separate templates with separate
      // channels — the tenant's receipt is gated by the receipt template alone.
      if (tenant.email && templateAllowsChannel(receiptCopy.channel, "email")) {
        const tenantEmail = await enqueueNotification({
          type: "receipt",
          channel: "email",
          audience: "tenant",
          companyId,
          locale,
          tenantId: tenant.id,
          subject: receiptSubject,
          body: receiptBody,
          recipientAddress: tenant.email,
          templateCode: receiptCode,
          deliveryKey: `receipt:email:${deliverySet}`,
          payload: {
            payment_ids: uniqueIds,
            periods,
            recipients: [tenant.email],
            primary_payment_id: primaryId,
            ...receiptAttachments,
            ...missingPdfPayload(tenantMissingPdfs),
          },
        });
        if (tenantEmail) results.push(tenantEmail.id);
      }

      if (waNumber && templateAllowsChannel(receiptCopy.channel, "whatsapp")) {
        const waBody =
          receiptCopy.body != null
            ? stripMarkup(receiptCopy.body)
            : locale === "ar"
              ? `تم استلام دفعتك بنجاح.\nالمبلغ: ${amountLabel}\nالفترات: ${periods || "—"}\nالمرجع: ${reference}`
              : `Payment received.\nAmount: ${amountLabel}\nPeriods: ${periods || "—"}\nReference: ${reference}`;
        const tenantWa = await enqueueNotification({
          type: "receipt",
          channel: "whatsapp",
          audience: "tenant",
          companyId,
          locale,
          tenantId: tenant.id,
          subject: null,
          body: waBody,
          recipientAddress: waNumber,
          templateCode: receiptCode,
          deliveryKey: `receipt:whatsapp:${deliverySet}`,
          // A WhatsApp template binds payload keys, not the rendered body, so every
          // human-facing value the receipt names has to be carried here too.
          //
          // `attachment_paths` now rides on the WhatsApp leg: the Evolution
          // provider sends documents as media parts, so the tenant receives the
          // receipt PDF itself, not just the summary text. The historical
          // reason this key was withheld — Meta/Twilio cannot carry a document
          // without an approved DOCUMENT-header template — still holds for
          // those providers: their builders ignore `media`, so the only cost
          // under them is the dispatcher downloading a PDF it does not use.
          payload: {
            payment_ids: uniqueIds,
            periods,
            tenant_name: tenant.name,
            amount: amountLabel,
            payment_date: payments[0].payment_date,
            reference,
            primary_payment_id: primaryId,
            ...receiptRecord,
            ...receiptAttachments,
            ...missingPdfPayload(tenantMissingPdfs),
          },
        });
        if (tenantWa) results.push(tenantWa.id);
      }
    }

    return {
      ok: true as const,
      skipped: false,
      ids: results,
      ...(missingPdfs.length ? { missingPdfs } : {}),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "notifyPaymentSuccess failed",
    };
  }
}

/**
 * يبني معالج مهمة `payment.receipt`: يبني إيصال الدفعة ثم يترك الإرسال لعامل الإشعارات.
 *
 * The workflow gate is read here, at send time, rather than in the request: the
 * job may sit in the queue for a while, and an admin who paused the workflow in
 * the meantime must not have the receipt mailed after the pause.
 *
 * The run is recorded under the workflow's own key, so the registry shows how
 * the receipt ended — a receipt that went out without its PDF is an error
 * there, exactly as it was when the sender ran inside the request.
 *
 * The catalogue payload carries the workflow key the request ran under, so the
 * manual settlement is judged by the `manual-payment-invoice` workflow — its
 * own pause switch and its own recipients — and the card payment by
 * `payment-succeeded`. Reading one key for both would aim a staff-only
 * reconciliation receipt at the tenant, or silence a tenant's own receipt
 * because the card workflow was paused.
 */
export function createPaymentReceiptHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { paymentId, workflow } = ctx.payload as JobPayload<"payment.receipt">;
    const result = await runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      () =>
        runEventWorkflow<PaymentNotifyResult>({
          key: workflow,
          whenPaused: () => ({ ok: true as const, skipped: true, ids: [] }),
          run: (targets) => sendPaymentReceipts([paymentId], targets, ctx.companyId),
          outcomeOf: paymentNotifyOutcome,
        }),
    );
    return { paymentId, workflow, ...result };
  };
}
