import { useMemo } from "react";

import { ContractTabPanel } from "@/components/admin/tenant-detail/ContractTabPanel";
import {
  TenantWideTabs,
  type TenantDetailTabsProps,
} from "@/components/admin/tenant-detail/TenantWideTabs";
import { badgeVariants } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/provider";
import { contractStateTone } from "@/lib/statusTone";
import { orderContractsOldestFirst } from "@/lib/tenantLocations";
import { cn } from "@/lib/utils";

/**
 * تبويبات عقود المستأجر، ويُبلَّغ الأب بالعقد المختار حتى يتبعه الشعار.
 *
 * Uncontrolled `defaultValue` cannot tell the page-level StoreLogoCard which
 * tab is open. The parent owns the id so switching a tab swaps the logo.
 * Every contract still gets a tab whatever its state — an expired lease keeps
 * the invoices it raised. Ordered oldest first so the leading tab is the
 * tenant's first contract.
 */
export function TenantContractTabs({
  selectedContractId,
  onSelectedContractIdChange,
  ...props
}: TenantDetailTabsProps & {
  selectedContractId?: string | null;
  onSelectedContractIdChange?: (contractId: string) => void;
}) {
  const { t } = useI18n();
  const { tenant, companyId, contracts, tenantContracts } = props;
  const orderedContracts = useMemo(
    () => orderContractsOldestFirst(tenantContracts),
    [tenantContracts],
  );

  // `defaultValue` is read once, on mount. The contracts arrive from a query, so
  // mounting before they land would fix the default at `undefined` and leave the
  // strip with nothing selected even after they arrive.
  if (contracts.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

  // Nothing to split by contract, so show the tenant-wide view on its own. The
  // combined tables are only redundant next to per-contract tabs; without them
  // they are the only way to reach this tenant's documents and invoices.
  if (!orderedContracts.length) return <TenantWideTabs {...props} />;

  const tabValue = selectedContractId ?? orderedContracts[0].id;

  return (
    <Tabs value={tabValue} onValueChange={onSelectedContractIdChange}>
      {/* `justify-center` rather than the default start alignment: the strip
          otherwise hugs the writing direction, which puts it on the right in
          Arabic and the left in English for no reason either audience asked
          for. Centring reads the same in both. */}
      <TabsList className="h-auto w-full flex-wrap justify-center gap-2">
        {orderedContracts.map((contract) => (
          <TabsTrigger
            key={contract.id}
            value={contract.id}
            className={cn(
              badgeVariants({ variant: contractStateTone(contract.state) }),
              "h-10 min-w-28 rounded-md px-5 font-mono text-base",
              // Beats the state tone above for the selected tab only. `cn` is
              // tailwind-merge, so these later bg-/text- classes win the
              // conflict rather than depending on stylesheet order — which is
              // what makes composing with badgeVariants safe at all.
              "data-[state=active]:bg-sky-200 data-[state=active]:text-black",
              "data-[state=active]:shadow-sm",
            )}
          >
            {contract.code}
          </TabsTrigger>
        ))}
      </TabsList>

      {orderedContracts.map((contract) => (
        <TabsContent key={contract.id} value={contract.id}>
          <ContractTabPanel contract={contract} tenant={tenant} companyId={companyId} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
