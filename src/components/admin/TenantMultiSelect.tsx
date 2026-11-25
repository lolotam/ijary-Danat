import { useMemo, useState } from "react";

import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useTenants } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";

/**
 * Searchable checkbox list of tenants, by default only those whose lifecycle is
 * `active`.
 *
 * Shared by the create-user dialog and the standalone assign dialog so both
 * offer the same list and the same select-all semantics.
 */
export function TenantMultiSelect({
  selected,
  onChange,
  enabled = true,
  includeInactive = false,
}: {
  selected: string[];
  onChange: (tenantIds: string[]) => void;
  /** Skips the query while the containing dialog is closed. */
  enabled?: boolean;
  /**
   * Drops the `active` filter.
   *
   * Required wherever a portal login is created, because migration 54 made
   * lifecycle derived: a tenant with no contract yet is `inactive` by
   * definition, and the normal order of work is create the tenant → create
   * their login → *then* activate the contract. Without this, that flow becomes
   * impossible — on production it would hide 12 of 17 tenants.
   */
  includeInactive?: boolean;
}) {
  const { t, locale } = useI18n();
  const tenantsQuery = useTenants(
    { pageSize: 1000, ...(includeInactive ? {} : { lifecycle: "active" as const }) },
    enabled,
  );
  const [search, setSearch] = useState("");

  const items = tenantsQuery.data?.items;
  const visibleTenants = useMemo(() => {
    const tenants = items ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return tenants;
    return tenants.filter((tenant) =>
      [tenant.name, tenant.name_en ?? "", tenant.code ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [search, items]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={search}
          placeholder={t("users.assignTenantsSearch")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Badge variant="secondary" className="shrink-0">
          {selected.length}
        </Badge>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          // Select-all applies to the current filter, so a search narrows what
          // gets added rather than silently selecting rows the user can't see.
          onClick={() =>
            onChange([...new Set([...selected, ...visibleTenants.map((tenant) => tenant.id)])])
          }
        >
          {t("users.selectAll")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>
          {t("users.clearAll")}
        </Button>
      </div>

      <div className="max-h-64 min-h-0 flex-1 overflow-y-auto rounded-lg border">
        {tenantsQuery.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : !visibleTenants.length ? (
          <p className="p-4 text-sm text-muted-foreground">{t("users.assignTenantsEmpty")}</p>
        ) : (
          visibleTenants.map((tenant, index) => (
            <label
              key={tenant.id}
              className="flex cursor-pointer items-center gap-3 border-b p-3 last:border-b-0 hover:bg-muted/50"
            >
              <Checkbox
                checked={selected.includes(tenant.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected, tenant.id]
                      : selected.filter((id) => id !== tenant.id),
                  )
                }
              />
              <span className="min-w-0 flex-1">
                <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                  <span className="text-sm font-medium">{tenantDisplayName(tenant, locale)}</span>
                </TenantOptionLabel>
                {tenant.code ? (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {tenant.code}
                  </span>
                ) : null}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
