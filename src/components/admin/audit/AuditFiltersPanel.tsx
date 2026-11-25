import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SYSTEM_ACTOR, useAuditFilterOptions, type AuditLogFilters } from "@/hooks/useAuditLogs";
import { useI18n } from "@/i18n/provider";
import type { AuditResult } from "@/integrations/supabase/database.types";
import { auditActionLabel, auditEntityLabel, auditRoleLabel } from "@/lib/auditLabels";

export type UpdateAuditFilter = <Key extends keyof AuditLogFilters>(
  key: Key,
  value: AuditLogFilters[Key],
) => void;

type Option = { value: string; label: string };

/** قائمة منسدلة لفلتر واحد، أول خياراتها "الكل". */
function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | undefined;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value ?? "all"} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * لوحة فلاتر سجل التدقيق: المنفّذ، الدور، الإجراء، نوع الكيان، النتيجة، والفترة.
 *
 * Every dropdown lists only values that exist in the log (`audit_log_filter_options`),
 * shown translated and sorted by their translated label, so an admin picks from
 * what actually happened instead of guessing a code. Filtering stays exact on
 * the raw code, which is what the indexes on `action` and `entity_type` serve.
 */
export function AuditFiltersPanel({
  filters,
  updateFilter,
  resetFilters,
}: {
  filters: AuditLogFilters;
  updateFilter: UpdateAuditFilter;
  resetFilters: () => void;
}) {
  const { t, locale } = useI18n();
  const options = useAuditFilterOptions();
  const data = options.data;

  /** يحوّل قائمة أكواد إلى خيارات مترجمة مرتبة حسب النص الظاهر. */
  const translated = (codes: string[] | undefined, toLabel: (code: string) => string) =>
    (codes ?? [])
      .map((code) => ({ value: code, label: toLabel(code) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));

  const actorOptions: Option[] = [
    { value: SYSTEM_ACTOR, label: t("audit.system") },
    ...(data?.actors ?? []).map((actor) => ({ value: actor.id, label: actor.label ?? actor.id })),
  ];

  return (
    <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <FilterSelect
        label={t("audit.filters.actor")}
        allLabel={t("audit.filters.allActors")}
        value={filters.actor}
        options={actorOptions}
        onChange={(value) => updateFilter("actor", value)}
      />
      <FilterSelect
        label={t("audit.role")}
        allLabel={t("audit.filters.allRoles")}
        value={filters.role}
        options={translated(data?.roles, (code) => auditRoleLabel(code, locale))}
        onChange={(value) => updateFilter("role", value)}
      />
      <FilterSelect
        label={t("audit.action")}
        allLabel={t("audit.filters.allActions")}
        value={filters.action}
        options={translated(data?.actions, (code) => auditActionLabel(code, locale))}
        onChange={(value) => updateFilter("action", value)}
      />
      <FilterSelect
        label={t("audit.entityType")}
        allLabel={t("audit.filters.allEntityTypes")}
        value={filters.entityType}
        options={translated(data?.entity_types, (code) => auditEntityLabel(code, locale))}
        onChange={(value) => updateFilter("entityType", value)}
      />
      <div className="space-y-2">
        <Label>{t("audit.result")}</Label>
        <Select
          value={filters.result ?? "all"}
          onValueChange={(result) => updateFilter("result", result as AuditResult | "all")}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("audit.allResults")}</SelectItem>
            <SelectItem value="success">{t("audit.success")}</SelectItem>
            <SelectItem value="failure">{t("audit.failure")}</SelectItem>
            <SelectItem value="error">{t("audit.error")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="audit-from">{t("common.from")}</Label>
        <DateInput
          id="audit-from"
          value={filters.from ?? ""}
          onChange={(value) => updateFilter("from", value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="audit-to">{t("common.to")}</Label>
        <DateInput
          id="audit-to"
          value={filters.to ?? ""}
          onChange={(value) => updateFilter("to", value)}
        />
      </div>
      <div className="flex items-end">
        <Button type="button" variant="outline" className="w-full" onClick={resetFilters}>
          <X className="size-4" />
          {t("audit.filters.reset")}
        </Button>
      </div>
    </div>
  );
}
