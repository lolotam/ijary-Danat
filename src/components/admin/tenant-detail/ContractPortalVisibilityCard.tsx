import { EyeOff, Home } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useSetContractPortalVisibility } from "@/hooks/useContractPortalVisibility";
import type { ContractUnitDetail } from "@/hooks/useContractRelations";
import type { Contract } from "@/hooks/useContracts";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { isRoofContract } from "@/lib/isRoofContract";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * مفتاح إخفاء العقد وفواتيره عن بوابة المستأجر، مع شارة تُرجّح عقود السطح.
 *
 * Rendered for every contract, not only the ones that look like roof leases.
 * `isRoofContract` is a hint on the badge and nothing more: `units.floor` and
 * `units.type` are operator-editable free text, so gating the switch on them
 * would mean a renamed value in Settings → Lists could strand an already-hidden
 * contract with no control left to unhide it. Migration 173 refused to hang
 * behaviour off that catalogue and migration 210 kept the refusal.
 */
export function ContractPortalVisibilityCard({
  contract,
  units,
}: {
  contract: Contract;
  units: ContractUnitDetail[];
}) {
  const { t } = useI18n();
  const permissions = usePermissions();
  const setVisibility = useSetContractPortalVisibility();
  const canEdit = permissions.can(PERMISSIONS.CONTRACTS_UPDATE);
  const looksLikeRoof = isRoofContract(units);

  /**
   * يحفظ حالة المفتاح فورًا ويُعلم المستخدم بالنتيجة.
   *
   * No optimistic local state: `contract.hide_from_portal` is read straight from
   * the query cache, which the mutation invalidates on success. A local mirror
   * would show the switch flipped after a refusal the tenant portal never
   * honoured — and this switch decides what a tenant can see.
   */
  const onCheckedChange = (hide: boolean) => {
    setVisibility.mutate(
      { contractId: contract.id, hideFromPortal: hide },
      {
        onSuccess: () =>
          toast.success(
            hide
              ? t("contracts.portalVisibility.nowHidden")
              : t("contracts.portalVisibility.nowVisible"),
          ),
        onError: (error) =>
          toast.error(
            error instanceof Error ? error.message : t("contracts.portalVisibility.failed"),
          ),
      },
    );
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <EyeOff className="size-4 text-muted-foreground" />
            <Label htmlFor={`portal-visibility-${contract.id}`} className="text-sm font-medium">
              {t("contracts.portalVisibility.label")}
            </Label>
            {looksLikeRoof ? (
              <Badge variant="secondary" className="gap-1">
                <Home className="size-3" />
                {t("contracts.portalVisibility.roofBadge")}
              </Badge>
            ) : null}
          </div>
          <p className="max-w-prose text-xs text-muted-foreground">
            {t("contracts.portalVisibility.hint")}
          </p>
        </div>
        <Switch
          id={`portal-visibility-${contract.id}`}
          checked={contract.hide_from_portal}
          disabled={!canEdit || setVisibility.isPending}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </div>
  );
}
