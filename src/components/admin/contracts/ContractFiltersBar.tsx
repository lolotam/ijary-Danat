import { X } from "lucide-react";

import type { ReactNode } from "react";

import { FilterSelect } from "@/components/admin/FilterSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import {
  emptyContractTableFilters,
  hasActiveContractTableFilters,
  type ContractTableFilters,
} from "@/lib/contractTableFilters";
import { propertyFilterOptions } from "@/lib/propertyDisplayName";

/**
 * شريط بحث وتصفية جدول العقود على سطر واحد: المبنى، المستأجر، الحالة، نطاق الانتهاء، المتأخرات.
 *
 * `state` arrives as its own pair of props rather than inside `value` because
 * it is the one filter this page sends to the server: it narrows the list query
 * *and* the KPI cards through `useContractsSummary`, and folding it into the
 * client-side filter state would have quietly stopped the cards responding to
 * it. Everything else in `value` narrows the table only.
 *
 * "Clear filters" resets the client-side set and leaves the state dropdown
 * alone, for the same reason — clearing a table filter must not silently
 * change what the cards above are counting.
 */
export function ContractFiltersBar({
  search,
  onSearchChange,
  value,
  onChange,
  stateFilter,
  onStateFilterChange,
  properties,
  stateOptions,
  tenantOptions,
}: {
  search: string;
  onSearchChange: (next: string) => void;
  value: ContractTableFilters;
  onChange: (next: ContractTableFilters) => void;
  stateFilter: string;
  onStateFilterChange: (next: string) => void;
  properties: Array<Tables<"properties">>;
  stateOptions: Array<{ value: string; label: string }>;
  tenantOptions: Array<{ value: string; label: ReactNode }>;
}) {
  const { locale, t } = useI18n();
  const set = (patch: Partial<ContractTableFilters>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="contracts-search">{t("common.search")}</Label>
        <Input
          id="contracts-search"
          className="w-[18rem]"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("contracts.search")}
        />
      </div>

      <FilterSelect
        id="contracts-property"
        label={t("filters.property")}
        anyLabel={t("filters.allProperties")}
        className="w-[16rem]"
        value={value.propertyId}
        options={propertyFilterOptions(properties, locale)}
        onChange={(next) => set({ propertyId: next })}
      />

      <FilterSelect
        id="contracts-tenant"
        label={t("contracts.tenant")}
        anyLabel={t("filters.allTenants")}
        className="w-[16rem]"
        value={value.tenantId}
        options={tenantOptions}
        onChange={(next) => set({ tenantId: next })}
      />

      <FilterSelect
        id="contracts-state"
        label={t("contracts.state")}
        anyLabel={t("filters.allStates")}
        value={stateFilter === "all" ? "" : stateFilter}
        options={stateOptions}
        onChange={(next) => onStateFilterChange(next || "all")}
      />

      <div className="space-y-1">
        <Label htmlFor="contracts-expiry-from">{t("filters.expiryFrom")}</Label>
        <Input
          id="contracts-expiry-from"
          type="date"
          className="w-[10rem]"
          value={value.expiryFrom}
          onChange={(event) => set({ expiryFrom: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="contracts-expiry-to">{t("filters.expiryTo")}</Label>
        <Input
          id="contracts-expiry-to"
          type="date"
          className="w-[10rem]"
          value={value.expiryTo}
          onChange={(event) => set({ expiryTo: event.target.value })}
        />
      </div>

      <FilterSelect
        id="contracts-arrears"
        label={t("filters.arrears")}
        anyLabel={t("filters.arrearsAny")}
        className="w-[11rem]"
        value={value.arrears}
        options={[
          { value: "yes", label: t("filters.arrearsOnly") },
          { value: "no", label: t("filters.arrearsNone") },
        ]}
        onChange={(next) => set({ arrears: next })}
      />

      {hasActiveContractTableFilters(value) && (
        <Button variant="ghost" size="sm" onClick={() => onChange(emptyContractTableFilters)}>
          <X className="size-4" />
          {t("filters.clear")}
        </Button>
      )}
    </div>
  );
}
