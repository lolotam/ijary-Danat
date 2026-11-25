import { X } from "lucide-react";

import { FilterSelect } from "@/components/admin/FilterSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { propertyFilterOptions } from "@/lib/propertyDisplayName";
import {
  emptyTenantTableFilters,
  hasActiveTenantTableFilters,
  type TenantTableFilters,
} from "@/lib/tenantTableFilters";

const LIFECYCLES = ["active", "inactive", "contract_ended", "blocked"] as const;

/**
 * شريط بحث وتصفية جدول المستأجرين على سطر واحد: المبنى، التصنيف، الحالة، المتأخرات.
 *
 * The search box sits inside the same flex row as the filters rather than above
 * them, because they are one control surface: an admin narrowing a list moves
 * between typing a name and picking a building without the layout implying they
 * are separate steps.
 *
 * Like the payments bar, this narrows the table only — the KPI cards above keep
 * reading module-wide totals. A figure labelled "total tenants" that silently
 * followed the current filter would be a reporting trap.
 */
export function TenantFiltersBar({
  search,
  onSearchChange,
  value,
  onChange,
  properties,
  categoryOptions,
}: {
  search: string;
  onSearchChange: (next: string) => void;
  value: TenantTableFilters;
  onChange: (next: TenantTableFilters) => void;
  properties: Array<Tables<"properties">>;
  categoryOptions: Array<{ value: string; label: string }>;
}) {
  const { locale, t } = useI18n();
  const set = (patch: Partial<TenantTableFilters>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="tenants-search">{t("common.search")}</Label>
        <Input
          id="tenants-search"
          className="w-[18rem]"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("tenants.search")}
        />
      </div>

      <FilterSelect
        id="tenants-property"
        label={t("filters.property")}
        anyLabel={t("filters.allProperties")}
        className="w-[16rem]"
        value={value.propertyId}
        options={propertyFilterOptions(properties, locale)}
        onChange={(next) => set({ propertyId: next })}
      />

      <FilterSelect
        id="tenants-category"
        label={t("tenants.category")}
        anyLabel={t("filters.allCategories")}
        value={value.category}
        options={categoryOptions}
        onChange={(next) => set({ category: next })}
      />

      <FilterSelect
        id="tenants-lifecycle"
        label={t("tenants.lifecycle")}
        anyLabel={t("filters.allLifecycles")}
        value={value.lifecycle}
        options={LIFECYCLES.map((lifecycle) => ({
          value: lifecycle,
          label: t(`tenantLifecycle.${lifecycle}`),
        }))}
        onChange={(next) => set({ lifecycle: next })}
      />

      <FilterSelect
        id="tenants-arrears"
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

      {hasActiveTenantTableFilters(value) && (
        <Button variant="ghost" size="sm" onClick={() => onChange(emptyTenantTableFilters)}>
          <X className="size-4" />
          {t("filters.clear")}
        </Button>
      )}
    </div>
  );
}
