import { useMemo, useState } from "react";

import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useContractedTenants, type ContractedTenant } from "@/hooks/useContractedTenants";
import { useI18n } from "@/i18n/provider";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * Single-tenant dropdown for creating a tenant portal login.
 *
 * Reports the whole selected tenant, not just its id, so the caller can prefill
 * the account from it. Which fields get prefilled is deliberately the caller's
 * decision — this component only answers "which tenant".
 *
 * Lists only tenants with a contract and no portal account yet (see
 * `useContractedTenants`), so one tenant cannot be given two logins.
 *
 * A plain select rather than the searchable checkbox list `TenantMultiSelect`
 * offers: a portal login maps to exactly one tenant (`profiles.tenant_id`), and
 * a multi-select there let an admin build a selection the form would reject.
 */
export function TenantPicker({
  value,
  onSelect,
  enabled = true,
}: {
  /** Selected tenant id, or "" for none. */
  value: string;
  onSelect: (tenant: ContractedTenant) => void;
  /** Skips the query while the containing dialog is closed. */
  enabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const tenantsQuery = useContractedTenants(enabled);
  const tenants = tenantsQuery.data ?? [];
  const [search, setSearch] = useState("");

  const filteredTenants = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter((tenant) =>
      [tenantDisplayName(tenant, locale), tenant.code ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [tenants, search, locale]);

  // An empty list and a list that has not arrived look identical in a select
  // whose only feedback is a placeholder, so both are named explicitly. Without
  // this an admin reads "no tenants have contracts" off a query that is still
  // in flight, or off one that failed.
  const status = tenantsQuery.isLoading
    ? t("common.loading")
    : tenantsQuery.error
      ? t("common.error")
      : !tenants.length
        ? t("users.contractedTenantsEmpty")
        : null;

  return (
    <div className="grid gap-1.5">
      <Select
        value={value}
        disabled={!tenants.length}
        onValueChange={(id) => {
          const tenant = tenants.find((candidate) => candidate.id === id);
          if (tenant) onSelect(tenant);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder={t("users.selectTenantPlaceholder")} />
        </SelectTrigger>
        <SelectContent className="max-w-[min(92vw,32rem)]">
          <div className="p-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("common.search")}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </div>
          {filteredTenants.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("common.noResults")}</p>
          ) : (
            filteredTenants.map((tenant, index) => (
              <SelectItem key={tenant.id} value={tenant.id} className="truncate">
                <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                  {tenantDisplayName(tenant, locale)}
                  {tenant.code ? ` — ${tenant.code}` : ""}
                </TenantOptionLabel>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <p
        className={
          tenantsQuery.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
      >
        {status ?? t("users.contractedTenantsHint")}
      </p>
    </div>
  );
}
