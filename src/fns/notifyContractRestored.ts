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
import { requirePermission } from "@/fns/requirePermission";
import { translatorFor } from "@/i18n/dictionary";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tables } from "@/integrations/supabase/database.types";

const WORKFLOW_KEY = "contract-restored";
const schema = z.object({
  contractId: z.string().uuid(),
  targetState: z.string().min(1),
  reason: z.string().min(1),
});

/** ما يصف عملية الاستعادة: الحالة التي عاد إليها العقد، ولماذا. */
interface RestoreDetails {
  targetState: string;
  reason: string;
}

/** يبني رسالة استعادة العقد وحمولتها. */
async function buildRestoredMessage(
  contract: Tables<"contracts">,
  details: RestoreDetails,
): Promise<AdminEmailMessage> {
  const [{ locale }, tenantName] = await Promise.all([
    loadCompanyDefaults(),
    loadTenantName(contract.tenant_id),
  ]);
  const variables = {
    tenant_name: tenantName,
    contract_code: contract.code,
    target_state: details.targetState,
    reason: details.reason,
  };
  const t = translatorFor(locale);
  const copy = await renderAdminEmailCopy({
    code: "contract-restored",
    locale,
    variables,
    fallbackSubject: t("workflows.fallbackSubject.contractRestored").replace(
      "{code}",
      contract.code,
    ),
    fallbackBody: (safe) =>
      `<p>${safe.tenant_name} — ${safe.contract_code}</p><p>${safe.target_state}: ${safe.reason}</p>`,
  });
  return { copy, payload: { ...variables, contract_id: contract.id } };
}

/**
 * يرسل تنبيه استعادة العقد إلى الإدارة عبر بوابة سير العمل.
 *
 * Deduplicated on contract and reason together: one contract can be restored
 * more than once, and each restore is its own event.
 */
export async function notifyContractRestoredRecord(
  contractId: string,
  targetState: string,
  reason: string,
): Promise<AdminNotificationResult> {
  return notifyAdminEvent(WORKFLOW_KEY, {
    type: "contract_restored",
    load: async () =>
      rowOrThrow(
        await companyClient(requireRequestCompany().id)
          .from("contracts")
          .select("*")
          .eq("id", contractId)
          .single(),
      ),
    dedupeMatch: { contract_id: contractId, reason },
    build: (contract) => buildRestoredMessage(contract, { targetState, reason }),
    // Mail failure must never reject a financially committed restore.
    sendFailureReason: "Restore notification send failed.",
  });
}

export const notifyContractRestored = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "contracts.restore",
      attempted: "notification.contract_restored",
      refusal: "You do not have permission to restore a contract.",
    });
    return notifyContractRestoredRecord(data.contractId, data.targetState, data.reason);
  });
