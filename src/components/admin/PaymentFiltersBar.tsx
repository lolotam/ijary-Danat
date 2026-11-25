import { X } from "lucide-react";

import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Tables } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import {
  emptyPaymentFilters,
  hasActivePaymentFilters,
  type PaymentFilters,
} from "@/lib/paymentFilters";
import { ANY_VALUE, fromAnyValue } from "@/lib/selectSentinel";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";

const STATUSES = ["confirmed", "pending", "reversed"] as const;

/**
 * شريط بحث وتصفية جدول المدفوعات على سطر واحد: التاريخ، الطريقة، المستأجر، المبلغ، الحالة.
 *
 * The search box sits inside the same flex row as the filters rather than above
 * them, matching the tenants and contracts bars: they are one control surface,
 * and an admin narrowing a list moves between typing a name and picking a date
 * without the layout implying those are separate steps.
 *
 * Filters the Full tab's table only, never the summary cards above it. Those
 * read module-wide totals, and a "total payments" figure that silently narrowed
 * to the current filter while still being labelled a total is a reporting trap —
 * the same reasoning that kept the search box local when this page was built.
 *
 * A shadcn `Select` cannot hold an empty-string item value, so "any" is a
 * sentinel that maps back to "" on the way out rather than a real option value.
 */
export function PaymentFiltersBar({
  search,
  onSearchChange,
  value,
  onChange,
  methodOptions,
  tenants,
}: {
  search: string;
  onSearchChange: (next: string) => void;
  value: PaymentFilters;
  onChange: (next: PaymentFilters) => void;
  methodOptions: Array<{ value: string; label: string }>;
  tenants: Array<Tables<"tenants">>;
}) {
  const { locale, t } = useI18n();
  const set = (patch: Partial<PaymentFilters>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="payments-search">{t("common.search")}</Label>
        <Input
          id="payments-search"
          className="w-[18rem]"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("payments.search")}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-date-from">{t("payments.dateFrom")}</Label>
        <Input
          id="payments-date-from"
          type="date"
          className="w-[10rem]"
          value={value.dateFrom}
          onChange={(event) => set({ dateFrom: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-date-to">{t("payments.dateTo")}</Label>
        <Input
          id="payments-date-to"
          type="date"
          className="w-[10rem]"
          value={value.dateTo}
          onChange={(event) => set({ dateTo: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-method">{t("payments.method")}</Label>
        <Select
          value={value.method || ANY_VALUE}
          onValueChange={(next) => set({ method: fromAnyValue(next) })}
        >
          <SelectTrigger id="payments-method" className="w-[11rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>{t("payments.allMethods")}</SelectItem>
            {methodOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-status">{t("common.status")}</Label>
        <Select
          value={value.status || ANY_VALUE}
          onValueChange={(next) => set({ status: fromAnyValue(next) })}
        >
          <SelectTrigger id="payments-status" className="w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>{t("payments.allStatuses")}</SelectItem>
            {STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`paymentStatus.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-tenant">{t("tenants.title")}</Label>
        <Select
          value={value.tenantId || ANY_VALUE}
          onValueChange={(next) => set({ tenantId: fromAnyValue(next) })}
        >
          <SelectTrigger id="payments-tenant" className="w-[13rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_VALUE}>{t("payments.allTenants")}</SelectItem>
            {tenants.map((tenant, index) => (
              <SelectItem key={tenant.id} value={tenant.id}>
                <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                  {tenantDisplayName(tenant, locale)}
                </TenantOptionLabel>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-amount-min">{t("payments.amountMin")}</Label>
        <Input
          id="payments-amount-min"
          type="number"
          // Money here runs to three decimals (KWD fils); the default step of 1
          // makes 3.500 fail native validation and the field silently refuses.
          step="0.001"
          min="0"
          className="w-[8rem]"
          value={value.amountMin}
          onChange={(event) => set({ amountMin: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="payments-amount-max">{t("payments.amountMax")}</Label>
        <Input
          id="payments-amount-max"
          type="number"
          step="0.001"
          min="0"
          className="w-[8rem]"
          value={value.amountMax}
          onChange={(event) => set({ amountMax: event.target.value })}
        />
      </div>

      {hasActivePaymentFilters(value) && (
        <Button variant="ghost" size="sm" onClick={() => onChange(emptyPaymentFilters)}>
          <X className="size-4" />
          {t("payments.clearFilters")}
        </Button>
      )}
    </div>
  );
}
