import { useMemo } from "react";

import { useContracts } from "@/hooks/useContracts";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantDisplayName } from "@/lib/tenantDisplayName";

export type ContractPickerOption = {
  contractId: string;
  label: string;
  tenantId: string;
};

/**
 * يبني تسمية العقد في قوائم الاختيار: رمز العقد ثم اسم المستأجر.
 *
 * Shared with `PaymentSidePanels`' contract directory so the two pickers cannot
 * drift into different label formats — the accountant moves between the partial
 * payments panel and the deposit form and should recognise the same row.
 */
export function contractPickerLabel(code: string, tenantName: string | null): string {
  return `${code} — ${tenantName ?? ""}`;
}

/**
 * قائمة العقود الحالية لاختيار عقد في نموذج الإيداع.
 *
 * Current contracts only. A deposit is money arriving now, so an archived
 * contract is not a plausible target — and `PaymentSidePanels` only widens to
 * archived ones because it renders inside an archived tenant's own tab, which
 * has no equivalent here.
 *
 * ONE PAGE, DELIBERATELY. `useContracts` paginates, and this asks for 500 rows
 * in one go, so a 501st current contract would not be selectable. That mirrors
 * `useContractDirectory`, which the partial-payments panel has used on the same
 * data since it was written — the two pickers sit beside each other in the
 * accountant's workflow and should not disagree about which contracts exist.
 * Production holds 15 current contracts. If that number ever approaches 500,
 * both pickers need a searchable server-side query, and changing only this one
 * would be the worse outcome.
 */
export function useContractPickerOptions(enabled = true): ContractPickerOption[] {
  const { locale } = useI18n();
  const permissions = usePermissions();
  const contracts = useContracts(
    { pageSize: 500, archiveMode: "current" },
    enabled && permissions.can(PERMISSIONS.CONTRACTS_READ),
  );

  return useMemo(
    () =>
      (contracts.data?.items ?? []).map((contract) => ({
        contractId: contract.id,
        tenantId: contract.tenant_id,
        label: contractPickerLabel(
          contract.code,
          contract.tenant ? tenantDisplayName(contract.tenant, locale) : null,
        ),
      })),
    [contracts.data?.items, locale],
  );
}
