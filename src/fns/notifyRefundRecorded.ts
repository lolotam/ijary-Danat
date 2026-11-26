import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import {
  loadCompanyDefaults,
  loadTenantName,
  notifyAdminEvent,
  renderAdminEmailCopy,
  rowOrThrow,
  type AdminEmailMessage,
  type AdminNotificationResult,
} from "@/fns/adminEmailNotification";
import { requireAnyPermission } from "@/fns/requirePermission";
import { translatorFor } from "@/i18n/dictionary";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/database.types";

const WORKFLOW_KEY = "refund-recorded";
const schema = z.object({ refundId: z.string().uuid() });

/** يبني رسالة تسجيل الاسترداد وحمولتها. */
async function buildRefundMessage(refund: Tables<"refunds">): Promise<AdminEmailMessage> {
  const [{ locale }, tenantName] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(refund.tenant_id),
  ]);
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "refund-recorded",
    locale,
    variables: {
      tenant_name: tenantName,
      amount: `${refund.amount} ${refund.currency}`,
      reason: refund.reason ?? refund.note ?? "",
      code: refund.id,
    },
    fallbackSubject: t("workflows.fallbackSubject.refundRecorded"),
    fallbackBody: (safe) => `<p>${safe.tenant_name} - ${safe.amount}</p><p>${safe.reason}</p>`,
  });
  return { copy, payload: { refund_id: refund.id } };
}

/** يرسل تنبيه تسجيل الاسترداد إلى الإدارة عبر بوابة سير العمل. */
export async function notifyRefundRecordedRecord(
  refundId: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "refund_recorded",
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("refunds")
          .select("*")
          .eq("id", refundId)
          .single(),
      ),
    dedupeMatch: { refund_id: refundId },
    build: buildRefundMessage,
  });
}

export const notifyRefundRecorded = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    // Recording a refund and editing one both send this alert.
    await requireAnyPermission(context, {
      codes: ["refunds.update", "refunds.create"],
      attempted: "notification.refund_recorded",
      refusal: "You do not have permission to record a refund.",
      entityType: "refund",
      entityId: data.refundId,
    });
    return notifyRefundRecordedRecord(data.refundId);
  });
