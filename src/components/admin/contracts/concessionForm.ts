import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { z } from "zod";

import type { Contract } from "@/hooks/useContracts";

const optionalNumber = z.preprocess(
  (value) => (value === "" || value == null ? undefined : Number(value)),
  z.number().nonnegative().optional(),
);

export const concessionSchema = z
  .object({
    type: z.enum(["free_months", "percentage_discount", "fixed_discount"]),
    free_months: optionalNumber,
    discount_percent: optionalNumber,
    discount_amount: optionalNumber,
    start_date: z.string(),
    end_date: z.string(),
    invoice_ids: z.array(z.string().min(1)),
    reason: z.string(),
    status: z.enum(["active", "expired", "cancelled"]),
  })
  .superRefine((value, context) => {
    if (value.type === "free_months") {
      if (!value.free_months) context.addIssue({ code: "custom", path: ["free_months"] });
      if (!value.start_date) context.addIssue({ code: "custom", path: ["start_date"] });
      if (!value.end_date || value.end_date < value.start_date) {
        context.addIssue({ code: "custom", path: ["end_date"] });
      }
      return;
    }
    if (!value.invoice_ids.length) {
      context.addIssue({ code: "custom", path: ["invoice_ids"] });
    }
    if (value.type === "percentage_discount" && value.discount_percent == null) {
      context.addIssue({ code: "custom", path: ["discount_percent"] });
    }
    if (value.type === "fixed_discount" && value.discount_amount == null) {
      context.addIssue({ code: "custom", path: ["discount_amount"] });
    }
  });

export type ConcessionValues = z.infer<typeof concessionSchema>;

export const concessionDefaults: ConcessionValues = {
  type: "free_months",
  free_months: 1,
  discount_percent: undefined,
  discount_amount: undefined,
  start_date: "",
  end_date: "",
  invoice_ids: [],
  reason: "",
  status: "active",
};

/**
 * ينهي الأشهر المجانية في آخر يوم من الشهر التقويمي رقم N من بداية العقد.
 *
 * Not `start + N months - 1 day`: free months are counted in whole calendar
 * months (`period_in_free_months` compares on `date_trunc('month', …)`), so a
 * contract starting 2026-08-15 with 3 free months ended 2026-11-14 and made
 * Aug, Sep, Oct **and Nov** free — four months for three requested. Anchoring
 * to the start of the contract's first month and ending at the end of the Nth
 * makes the stored range agree with the count the user typed.
 */
export function freeMonthsEndDate(contractStart: string, freeMonths: number | string) {
  const months = Number(freeMonths);
  if (!contractStart || !Number.isFinite(months) || months < 1) return "";
  const firstMonth = startOfMonth(new Date(`${contractStart}T00:00:00`));
  return format(endOfMonth(addMonths(firstMonth, months - 1)), "yyyy-MM-dd");
}

/**
 * يبني القيم الافتراضية لنموذج التنازل عند فتح الحوار على عقد.
 */
export function concessionFormDefaults(contract: Contract): ConcessionValues {
  const freeMonths = 1;
  return {
    ...concessionDefaults,
    free_months: freeMonths,
    start_date: contract.start_date,
    end_date: freeMonthsEndDate(contract.start_date, freeMonths) || contract.end_date,
  };
}
