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

const WORKFLOW_KEY = "contract-closeout-completed";
const schema = z.object({ closeoutId: z.string().uuid() });

/** يبني رسالة إغلاق العقد وحمولتها. */
async function buildCloseoutMessage(
  closeout: Tables<"contract_closeouts">,
): Promise<AdminEmailMessage> {
  const [{ locale }, tenantName, contractCode] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(closeout.tenant_id),
    loadContractCode(closeout.contract_id),
  ]);
  const variables = {
    tenant_name: tenantName,
    contract_code: contractCode,
    closeout_id: closeout.id,
    outcome: closeout.outcome,
    move_out_date: closeout.move_out_date,
    refund_total: `${closeout.refund_total} KWD`,
    balance_due: `${closeout.balance_due_tenant} KWD`,
  };
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "contract-closeout",
    locale,
    variables,
    fallbackSubject: t("workflows.fallbackSubject.contractCloseout").replace(
      "{code}",
      contractCode,
    ),
    fallbackBody: (safe) =>
      `<p>${safe.tenant_name} — ${safe.contract_code}</p><p>${safe.outcome} · ${safe.refund_total}</p>`,
  });
  return { copy, payload: { ...variables, contract_id: closeout.contract_id } };
}

/** يرسل تنبيه إغلاق العقد إلى الإدارة عبر بوابة سير العمل. */
export async function notifyContractCloseoutRecord(
  closeoutId: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "contract_closeout",
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("contract_closeouts")
          .select("*")
          .eq("id", closeoutId)
          .single(),
      ),
    dedupeMatch: { closeout_id: closeoutId },
    build: buildCloseoutMessage,
    // Mail failure must never reject a financially committed close-out.
    sendFailureReason: "Close-out notification send failed.",
  });
}

export const notifyContractCloseout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.close_out",
      attempted: "notification.contract_closeout",
      refusal: "You do not have permission to close out a contract.",
    });
    return notifyContractCloseoutRecord(data.closeoutId);
  });
