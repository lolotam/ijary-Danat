import { z } from "zod";

import type { Expense, ExpenseWithRelations } from "@/hooks/useExpenses";
import type { ExpenseClass } from "@/integrations/supabase/database.types";

/** تكرارات المصروف المتاحة في النموذج. */
export const EXPENSE_RECURRENCES = ["monthly", "quarterly", "annual", "one_time"] as const;
/** حالات المصروف المتاحة في النموذج. */
export const EXPENSE_STATUSES = ["pending", "approved", "cancelled"] as const;

/**
 * يشتق فئة المصروف من تكراره.
 *
 * The visible "expense class" field was removed — recurrence is the single
 * source of truth. The DB column is still NOT NULL, so it is derived here.
 */
export function classFromRecurrence(recurrence: string): ExpenseClass {
  switch (recurrence) {
    case "monthly":
    case "quarterly":
      return "regular_recurring";
    case "annual":
      return "contractual_annual";
    default:
      return "sudden_one_time";
  }
}

/** مخطط نموذج المصروف: كل الحقول نصوص كما تُحرَّر، والمبلغ رقم غير سالب. */
export const expenseSchema = z
  .object({
    category_id: z.string(),
    payee: z.string(),
    amount: z.coerce.number().finite().nonnegative(),
    currency: z.string().trim().min(1),
    property_id: z.string(),
    unit_id: z.string(),
    cost_center: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    recurrence: z.string(),
    expense_date: z.string().date(),
    status: z.enum(EXPENSE_STATUSES),
    note: z.string(),
  })
  .refine((value) => !value.start_date || !value.end_date || value.end_date >= value.start_date, {
    message: "End date must not precede start date.",
    path: ["end_date"],
  });

/** قيم نموذج المصروف كما يحرّرها المستخدم. */
export type ExpenseForm = z.infer<typeof expenseSchema>;

/** نموذج مصروف فارغ لإضافة جديدة: الدينار الكويتي، تاريخ اليوم، ومعتمد. */
export const emptyExpense = (): ExpenseForm => ({
  category_id: "",
  payee: "",
  amount: 0,
  currency: "KWD",
  property_id: "",
  unit_id: "",
  cost_center: "",
  start_date: "",
  end_date: "",
  recurrence: "",
  expense_date: new Date().toISOString().slice(0, 10),
  status: "approved",
  note: "",
});

/** يحوّل صف مصروف محفوظاً إلى قيم النموذج — القيم الفارغة تصبح نصوصاً فارغة. */
export function expenseToForm(expense: ExpenseWithRelations): ExpenseForm {
  return {
    category_id: expense.category_id ?? "",
    payee: expense.payee ?? "",
    amount: expense.amount,
    currency: expense.currency,
    property_id: expense.property_id ?? "",
    unit_id: expense.unit_id ?? "",
    cost_center: expense.cost_center ?? "",
    start_date: expense.start_date ?? "",
    end_date: expense.end_date ?? "",
    recurrence: expense.recurrence ?? "",
    expense_date: expense.expense_date,
    status: expense.status,
    note: expense.note ?? "",
  };
}

/**
 * يبني حمولة الحفظ من قيم النموذج: النصوص الفارغة تصبح null والفئة تُشتق.
 *
 * `building_id` is always null: the form offers property and unit, never a
 * building, and the column must not keep a stale value from an older row.
 */
export function expensePayload(
  values: ExpenseForm,
  context: { companyId: string | null; attachment: File | null },
) {
  return {
    company_id: context.companyId,
    class: classFromRecurrence(values.recurrence),
    category_id: values.category_id || null,
    payee: values.payee || null,
    amount: values.amount,
    currency: values.currency,
    property_id: values.property_id || null,
    building_id: null,
    unit_id: values.unit_id || null,
    cost_center: values.cost_center || null,
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    recurrence: (values.recurrence || null) as Expense["recurrence"],
    expense_date: values.expense_date,
    status: values.status,
    note: values.note || null,
    attachment: context.attachment,
  };
}
