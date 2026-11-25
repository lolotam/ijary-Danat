import type { PaymentListParams } from "@/hooks/usePayments";
import type { PaymentMethod } from "@/integrations/supabase/database.types";

/**
 * حالة شريط التصفية في صفحة المدفوعات، كنصوص كما تصل من الحقول.
 *
 * Everything is a string because that is what an `<input>` and a `<Select>`
 * hand back. Turning them into query parameters is `toPaymentQueryParams`'s job
 * and happens in one place, so "empty means no filter" is decided once rather
 * than at each of six call sites.
 */
export interface PaymentFilters {
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  method: string;
  status: string;
  tenantId: string;
}

/** لا تصفية: كل الحقول فارغة. */
export const emptyPaymentFilters: PaymentFilters = {
  dateFrom: "",
  dateTo: "",
  amountMin: "",
  amountMax: "",
  method: "",
  status: "",
  tenantId: "",
};

/** هل يوجد أي مرشِّح مفعَّل؟ يقرِّر إظهار زر "مسح التصفية". */
export function hasActivePaymentFilters(filters: PaymentFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

/**
 * يحوّل حالة الشريط إلى معاملات الاستعلام، ويحذف كل حقل فارغ.
 *
 * An empty string is "no filter", never a filter for the empty value — sending
 * `method: ""` would ask PostgREST for payments whose method is the empty
 * string, and quietly return nothing at all.
 *
 * Amounts use `Number`, not `parseFloat`: `parseFloat("1.2.3")` returns 1.2 and
 * a mis-typed amount would silently filter on a number the admin never entered.
 * `Number("")` is 0, so the empty check has to come first or clearing the box
 * would read as a zero lower bound.
 */
export function toPaymentQueryParams(filters: PaymentFilters): PaymentListParams {
  const params: PaymentListParams = {};
  if (filters.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters.dateTo) params.dateTo = filters.dateTo;
  if (filters.method) params.method = filters.method as PaymentMethod;
  if (filters.status) params.status = filters.status as PaymentListParams["status"];
  if (filters.tenantId) params.tenantId = filters.tenantId;

  if (filters.amountMin !== "") {
    const min = Number(filters.amountMin);
    if (Number.isFinite(min)) params.amountMin = min;
  }
  if (filters.amountMax !== "") {
    const max = Number(filters.amountMax);
    if (Number.isFinite(max)) params.amountMax = max;
  }

  return params;
}
