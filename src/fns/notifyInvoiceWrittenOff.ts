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

const WORKFLOW_KEY = "invoice-written-off";
const schema = z.object({
  invoiceId: z.string().uuid(),
  /** Write-off reason lives in the audit trail, not on the invoice row. */
  reason: z.string().min(1),
});

/** يبني رسالة شطب الفاتورة وحمولتها من الفاتورة وسبب الشطب. */
async function buildWrittenOffMessage(
  invoice: Tables<"invoices">,
  reason: string,
): Promise<AdminEmailMessage> {
  const [{ locale, currency }, tenantName, contractCode] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(invoice.tenant_id),
    loadContractCode(invoice.contract_id),
  ]);
  const variables = {
    tenant_name: tenantName,
    invoice_code: invoice.code,
    amount: `${invoice.balance} ${currency}`,
    reason,
    contract_code: contractCode,
  };
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "invoice-written-off",
    locale,
    variables,
    fallbackSubject: t("workflows.fallbackSubject.invoiceWrittenOff").replace(
      "{code}",
      invoice.code,
    ),
    fallbackBody: (safe) =>
      `<p>${safe.tenant_name} — ${safe.invoice_code}</p><p>${safe.amount} · ${safe.reason}</p>`,
  });
  return {
    copy,
    payload: { ...variables, invoice_id: invoice.id, contract_id: invoice.contract_id },
  };
}

/** يرسل تنبيه شطب الفاتورة إلى الإدارة عبر بوابة سير العمل. */
export async function notifyInvoiceWrittenOffRecord(
  invoiceId: string,
  reason: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "invoice_written_off",
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("invoices")
          .select("*")
          .eq("id", invoiceId)
          .single(),
      ),
    dedupeMatch: { invoice_id: invoiceId },
    build: (invoice) => buildWrittenOffMessage(invoice, reason),
    // Mail failure must never reject a financially committed write-off.
    sendFailureReason: "Write-off notification send failed.",
  });
}

export const notifyInvoiceWrittenOff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.write_off",
      attempted: "notification.invoice_written_off",
      refusal: "You do not have permission to write off an invoice.",
    });
    return notifyInvoiceWrittenOffRecord(data.invoiceId, data.reason);
  });
