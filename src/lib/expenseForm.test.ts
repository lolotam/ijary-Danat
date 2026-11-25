/**
 * منطق نموذج المصروف: اشتقاق الفئة، وتحويل الصف إلى نموذج، والنموذج إلى حمولة.
 *
 * These lived inside the 930-line expenses route, reachable only by mounting
 * it. As plain functions (audit M32) the rules can be asserted directly —
 * most importantly that the NOT NULL `class` column is always derivable, and
 * that empty form strings reach the database as null, not "".
 */
import { describe, expect, it } from "vitest";

import {
  classFromRecurrence,
  emptyExpense,
  expensePayload,
  expenseSchema,
  expenseToForm,
} from "@/lib/expenseForm";

describe("classFromRecurrence", () => {
  it.each([
    ["monthly", "regular_recurring"],
    ["quarterly", "regular_recurring"],
    ["annual", "contractual_annual"],
    ["one_time", "sudden_one_time"],
    // No recurrence chosen: the column is NOT NULL, so it still gets a class.
    ["", "sudden_one_time"],
  ])("%s → %s", (recurrence, expected) => {
    expect(classFromRecurrence(recurrence)).toBe(expected);
  });
});

describe("expensePayload", () => {
  it("turns empty strings into null and derives the class", () => {
    const payload = expensePayload(
      { ...emptyExpense(), amount: 25, payee: "", recurrence: "annual" },
      { companyId: "company-1", attachment: null },
    );

    expect(payload).toMatchObject({
      company_id: "company-1",
      class: "contractual_annual",
      payee: null,
      category_id: null,
      property_id: null,
      unit_id: null,
      building_id: null,
      recurrence: "annual",
      amount: 25,
    });
  });
});

describe("expenseToForm", () => {
  it("round-trips a saved row through the form without losing a value", () => {
    const row = {
      category_id: "cat-1",
      payee: "Water Co",
      amount: 12.5,
      currency: "KWD",
      property_id: "prop-1",
      unit_id: null,
      cost_center: null,
      start_date: "2026-01-01",
      end_date: null,
      recurrence: "monthly",
      expense_date: "2026-09-01",
      status: "approved",
      note: null,
    } as never;

    const form = expenseToForm(row);

    expect(form).toMatchObject({ unit_id: "", cost_center: "", end_date: "", note: "" });
    expect(expensePayload(form, { companyId: null, attachment: null })).toMatchObject({
      category_id: "cat-1",
      payee: "Water Co",
      unit_id: null,
      end_date: null,
      recurrence: "monthly",
    });
  });
});

describe("expenseSchema", () => {
  it("refuses an end date before the start date", () => {
    const result = expenseSchema.safeParse({
      ...emptyExpense(),
      start_date: "2026-05-01",
      end_date: "2026-04-01",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["end_date"]);
  });

  it("refuses a negative amount", () => {
    expect(expenseSchema.safeParse({ ...emptyExpense(), amount: -1 }).success).toBe(false);
  });
});
