import { addMonths, format, subDays } from "date-fns";
import { z } from "zod";

import type { ContractState, ContractType } from "@/integrations/supabase/database.types";

/**
 * يحوّل قيمة الحقل الرقمي إلى رقم ثم يفرض حداً أدنى.
 *
 * HTML number inputs keep the value as a string until submit; preprocess is
 * what makes `min` mean a number, not lexicographic order.
 */
const numberField = (minimum: number) =>
  z.preprocess((value) => Number(value), z.number().min(minimum));

/**
 * قيمة اختيار النشاط التجاري الفارغة.
 *
 * Radix Select rejects empty string — this sentinel means "no activity" and
 * is written as null on save (optional free-text column, migration 99).
 */
export const NO_COMMERCIAL_ACTIVITY = "__none__";

/**
 * إيجار الوحدة يجب أن يكون أكبر من صفر — صفر يولّد فواتير بقيمة صفر طوال مدة العقد.
 *
 * Deposit stays `numberField(0)`: a zero insurance amount is legitimate and
 * T7 depends on it being settable to zero.
 */
const positiveRentField = z.preprocess(
  (value) => Number(value),
  z.number().positive({ message: "contracts.monthlyAmountPositive" }),
);

/**
 * مصروف شهري إضافي على العقد: تصنيف ومبلغ موجب.
 *
 * `positive`, not `min(0)`: a zero-amount charge would add a 0.000 line to
 * every invoice the contract raises for its whole term — visible on the PDF,
 * meaning nothing, and impossible to tell from a data-entry slip. An operator
 * who wants no charge removes the row.
 */
const extraChargeSchema = z.object({
  category_id: z.string().uuid(),
  amount: z.preprocess(
    (value) => Number(value),
    z.number().positive({ message: "contracts.extraChargeAmountPositive" }),
  ),
});

export type ContractExtraChargeValue = z.infer<typeof extraChargeSchema>;

export const contractFormSchema = z.object({
  property_ids: z.array(z.string().min(1)).min(1),
  tenant_id: z.string().min(1),
  units: z
    .array(z.object({ unit_id: z.string().min(1), monthly_amount: positiveRentField }))
    .min(1, "Select at least one unit"),
  type: z.enum(["investment", "lease"]),
  state: z.enum(["draft", "active", "frozen", "suspended", "expired", "renewed", "terminated"]),
  /** Optional free-text catalogue value; empty/sentinel saves as null. */
  commercial_activity: z.string().optional().nullable(),
  start_date: z.string().min(1),
  end_date: z.string().min(1),
  duration_months: numberField(1),
  end_date_override_reason: z.string(),
  due_day: z.preprocess((value) => Number(value), z.number().int().min(1).max(28)),
  grace_days: z.preprocess((value) => Number(value), z.number().int().min(0)),
  deposit: numberField(0),
  /**
   * زيادة إيجار واحدة اختيارية؛ null يعني لا زيادة.
   */
  increase: z
    .object({
      after_years: z.preprocess((v) => Number(v), z.number().int().min(1)),
      type: z.enum(["percent", "fixed"]),
      value: z.preprocess(
        (v) => Number(v),
        z.number().positive({ message: "contracts.increase.valuePositive" }),
      ),
    })
    .refine((v) => v.type !== "percent" || v.value <= 100, {
      message: "contracts.increase.percentCap",
      path: ["value"],
    })
    .nullable(),
  /**
   * Recurring monthly charges beyond rent — cleaning, security, service.
   * Billed on every invoice the contract raises, as their own lines.
   */
  extra_charges: z.array(extraChargeSchema),
  notes: z.string(),
  /**
   * إخفاء المستندات القابلة للطباعة لهذا العقد في بوابة المستأجر.
   *
   * Behaviour flag (migration 173), not derived from units.floor/type. When
   * true, invoice and receipt PDFs for this contract's invoices are suppressed
   * in the tenant portal while the invoice rows themselves stay visible and
   * payable.
   */
  suppress_tenant_billing_docs: z.boolean().default(false),
});

export type ContractFormValues = z.infer<typeof contractFormSchema>;

export const contractFormDefaults: ContractFormValues = {
  property_ids: [],
  tenant_id: "",
  units: [],
  type: "investment",
  state: "draft",
  commercial_activity: NO_COMMERCIAL_ACTIVITY,
  start_date: "",
  end_date: "",
  duration_months: 36,
  end_date_override_reason: "",
  due_day: 1,
  grace_days: 1,
  deposit: 0,
  increase: null,
  extra_charges: [],
  notes: "",
  suppress_tenant_billing_docs: false,
};

export const contractStates: ContractState[] = [
  "draft",
  "active",
  "frozen",
  "suspended",
  "expired",
  "renewed",
  "terminated",
];

/**
 * يحسب تاريخ نهاية العقد الشامل: البداية + ن شهر − يوم واحد.
 *
 * HTML number inputs keep `duration_months` as a string until zod submit-
 * preprocess; date-fns `addMonths` does `getMonth() + amount + 1`, which
 * string-concatenates (e.g. 7 + "12" + 1 → "7121") and yields years like 2620.
 * Always coerce months to a finite number before calling date-fns.
 */
export function calculatedEndDate(startDate: string, durationMonths: number | string) {
  const months = Number(durationMonths);
  if (!startDate || !Number.isFinite(months) || months < 1) return "";
  return format(subDays(addMonths(new Date(`${startDate}T00:00:00`), months), 1), "yyyy-MM-dd");
}

/** شريحة من صف العقد تكفي لإعادة تعبئة النموذج. */
export type ContractFormSource = {
  tenant_id: string;
  type: ContractType;
  state: ContractState;
  commercial_activity: string | null;
  start_date: string;
  end_date: string;
  duration_months: number | null;
  end_date_override_reason: string | null;
  due_day: number;
  grace_days: number;
  deposit: number;
  /** Migration 196 trio — all three set or all null. */
  increase_after_years?: number | null;
  increase_type?: "percent" | "fixed" | null;
  increase_value?: number | null;
  notes: string | null;
  suppress_tenant_billing_docs?: boolean | null;
  units: Array<{
    monthlyAmount: number;
    unit: { id: string; property_id: string };
  }>;
};

/**
 * يبني قيم النموذج عند الفتح: إنشاء جديد أو تعبئة عقد قائم للتعديل.
 *
 * Every property behind the contract's units is included, not just the
 * primary one — a two-property contract must reopen with both properties
 * checked, or its second property's units vanish from the picker on the
 * first re-save.
 */
export function resolveContractFormValues(
  editing: ContractFormSource | null,
  extraCharges: ReadonlyArray<ContractExtraChargeValue> = [],
): ContractFormValues {
  if (!editing) return { ...contractFormDefaults };
  return {
    property_ids: [...new Set(editing.units.map((detail) => detail.unit.property_id))],
    tenant_id: editing.tenant_id,
    units: editing.units.map((detail) => ({
      unit_id: detail.unit.id,
      monthly_amount: detail.monthlyAmount,
    })),
    type: editing.type,
    state: editing.state,
    commercial_activity: editing.commercial_activity ?? NO_COMMERCIAL_ACTIVITY,
    start_date: editing.start_date,
    end_date: editing.end_date,
    duration_months: editing.duration_months ?? 36,
    end_date_override_reason: editing.end_date_override_reason ?? "",
    due_day: editing.due_day,
    grace_days: editing.grace_days,
    deposit: editing.deposit,
    increase:
      editing.increase_after_years != null && editing.increase_type
        ? {
            after_years: editing.increase_after_years,
            type: editing.increase_type,
            value: Number(editing.increase_value),
          }
        : null,
    // Read from their own table, not from `editing` — the contract row does
    // not carry them. An empty array here would be indistinguishable from a
    // contract that really has none, and saving would then delete the lot, so
    // the caller must not prefill until the query has actually answered.
    extra_charges: extraCharges.map((charge) => ({ ...charge })),
    notes: editing.notes ?? "",
    suppress_tenant_billing_docs: editing.suppress_tenant_billing_docs ?? false,
  };
}

/**
 * هل نهاية العقد المخزّنة تختلف عن الحساب من المدة، فيُعامل الحقل كتجاوز؟
 *
 * Treat as override when a reason exists OR stored end already differs from
 * duration-based calculation (so the reason field is writable).
 */
export function isEndDateOverridden(values: ContractFormValues): boolean {
  const calculated = calculatedEndDate(values.start_date, values.duration_months);
  return (
    Boolean(values.end_date_override_reason?.trim()) ||
    (Boolean(values.end_date) && Boolean(calculated) && values.end_date !== calculated)
  );
}

/**
 * إجمالي الفاتورة الشهرية: مجموع إيجارات الوحدات زائد المصروفات الإضافية.
 *
 * The same sum the database computes when it generates an invoice
 * (`generate_invoices_for_year`, via `contract_extra_charges_total`). Kept as
 * a pure function so the figure the form shows before saving and the figure
 * the tenant is eventually billed come from one rule that can be tested
 * against a worked example rather than two that happen to agree today.
 */
export function monthlyInvoiceTotal(
  units: ReadonlyArray<{ monthly_amount: number }>,
  extraCharges: ReadonlyArray<{ amount: number }>,
): number {
  const rent = units.reduce((sum, unit) => sum + (Number(unit.monthly_amount) || 0), 0);
  const extras = extraCharges.reduce((sum, charge) => sum + (Number(charge.amount) || 0), 0);
  return rent + extras;
}

/** حمولة الحفظ: حقول العقد ومصروفاته، وصفوف وحداته. */
export interface ContractSavePayload {
  contract: Omit<
    ContractFormValues,
    | "property_ids"
    | "units"
    | "extra_charges"
    | "commercial_activity"
    | "end_date_override_reason"
    | "notes"
    | "increase"
  > & {
    commercial_activity: string | null;
    end_date_override_reason: string | null;
    notes: string | null;
    extra_charges?: ContractExtraChargeValue[];
    increase_after_years: number | null;
    increase_type: "percent" | "fixed" | null;
    increase_value: number | null;
  };
  units: Array<{ unit_id: string; monthly_amount: number }>;
}

/**
 * يحوّل قيم النموذج إلى حمولة `save_contract_with_units`.
 *
 * Pure, and separate from the dialog, because two of the three transformations
 * here are silent-failure shapes rather than formatting:
 *
 *   - a charge row whose category was never chosen is a half-filled line, not a
 *     charge. Sending it fails the RPC's uuid cast on an empty string.
 *   - `end_date_override_reason` must write NULL when the operator turns the
 *     override off, so it is cleared by comparing against the calculated date
 *     rather than kept by coalescing.
 */
export function buildContractSavePayload(
  values: ContractFormValues,
  chargesAreKnown = true,
): ContractSavePayload {
  const calculated = calculatedEndDate(values.start_date, values.duration_months);
  const {
    property_ids: _propertyIds,
    units: unitRows,
    extra_charges: extraCharges,
    increase,
    ...contractValues
  } = values;
  const activity = values.commercial_activity;
  return {
    contract: {
      ...contractValues,
      // Migration 196 columns: null (not an omitted key) means "no increase",
      // including on update — the RPC's absent-key rule only matters for keys
      // the form never owns.
      increase_after_years: increase?.after_years ?? null,
      increase_type: increase?.type ?? null,
      increase_value: increase?.value ?? null,
      commercial_activity: !activity || activity === NO_COMMERCIAL_ACTIVITY ? null : activity,
      end_date_override_reason:
        values.end_date === calculated ? null : values.end_date_override_reason.trim(),
      notes: values.notes.trim() || null,
      // The key is OMITTED, not emptied, when the caller never learned what the
      // contract already charges. `save_contract_with_units` reads an absent
      // key as "leave them alone" and `[]` as "delete them all" (migration
      // 166), so sending the wrong one on a failed read cuts every future
      // invoice with nothing to show for it.
      ...(chargesAreKnown
        ? {
            extra_charges: extraCharges
              .filter((charge) => charge.category_id)
              .map((charge) => ({ category_id: charge.category_id, amount: charge.amount })),
          }
        : {}),
    },
    units: unitRows.map((row) => ({
      unit_id: row.unit_id,
      monthly_amount: row.monthly_amount,
    })),
  };
}
