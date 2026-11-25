import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TenantWithActiveLocation } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { tenantPortalState } from "@/lib/tenantPortalState";

/**
 * يعرض حالة البوابة في خلية واحدة.
 *
 * The decision itself lives in `lib/tenantPortalState.ts` so it can be tested
 * as a function; this component only renders it.
 */
export function TenantPortalValue({
  tenant,
  hasAccount,
  unknown,
}: {
  tenant: TenantWithActiveLocation;
  hasAccount: boolean;
  unknown: boolean;
}) {
  const { t } = useI18n();
  const state = tenantPortalState({
    portalEnabled: tenant.tenant_portal_enabled,
    hasAccount,
    accountsUnknown: unknown,
  });
  if (state === "disabled") return <>{t("common.no")}</>;
  if (state === "enabled") return <>{t("common.yes")}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" className="cursor-help">
          {t("tenants.portalNoAccount")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{t("tenants.portalNoAccountHint")}</TooltipContent>
    </Tooltip>
  );
}
