import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import {
  loadCompanyDefaults,
  loadContractCode,
  loadTenantName,
  notifyAdminEvent,
  renderAdminEmailCopy,
  rowOrThrow,
  type AdminEmailMessage,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { requirePermission } from "@/fns/requirePermission";
import { translatorFor } from "@/i18n/dictionary";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/database.types";

const WORKFLOW_KEY = "invoice-disputed";
const schema = z.object({ invoiceId: z.string().uuid() });

/** يبني رسالة النزاع وحمولتها؛ سبب النزاع محفوظ على الفاتورة نفسها. */
async function buildDisputedMessage(invoice: Tables<"invoices">): Promise<AdminEmailMessage> {
  const [{ locale, currency }, tenantName, contractCode] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(invoice.tenant_id),
    loadContractCode(invoice.contract_id),
  ]);
  const variables = {
    tenant_name: tenantName,
    invoice_code: invoice.code,
    amount: `${invoice.balance} ${currency}`,
    reason: invoice.dispute_reason ?? "",
    contract_code: contractCode,
  };
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "invoice-disputed",
    locale,
    variables,
    fallbackSubject: t("workflows.fallbackSubject.invoiceDisputed").replace("{code}", invoice.code),
    fallbackBody: (safe) =>
      `<p>${safe.tenant_name} — ${safe.invoice_code}</p><p>${safe.amount} · ${safe.reason}</p>`,
  });
  return {
    copy,
    payload: { ...variables, invoice_id: invoice.id, contract_id: invoice.contract_id },
  };
}

/** يرسل تنبيه النزاع على الفاتورة إلى الإدارة عبر بوابة سير العمل. */
export async function notifyInvoiceDisputedRecord(
  invoiceId: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "invoice_disputed",
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("invoices")
          .select("*")
          .eq("id", invoiceId)
          .single(),
      ),
    dedupeMatch: { invoice_id: invoiceId },
    build: buildDisputedMessage,
    // Mail failure must never reject a committed dispute flag.
    sendFailureReason: "Dispute notification send failed.",
  });
}

export const notifyInvoiceDisputed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.dispute",
      attempted: "notification.invoice_disputed",
      refusal: "You do not have permission to dispute an invoice.",
    });
    return notifyInvoiceDisputedRecord(data.invoiceId);
  });
