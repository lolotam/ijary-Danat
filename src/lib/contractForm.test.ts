import { describe, expect, test } from "vitest";

import {
  buildContractSavePayload,
  calculatedEndDate,
  contractFormDefaults,
  contractFormSchema,
  monthlyInvoiceTotal,
  NO_COMMERCIAL_ACTIVITY,
  resolveContractFormValues,
  type ContractFormValues,
} from "@/lib/contractForm";

/**
 * قيم نموذج صالحة لاختبار المخطط دون ملء كل الحقول يدوياً في كل حالة.
 */
function validValues(overrides: Partial<ContractFormValues> = {}): ContractFormValues {
  return {
    ...contractFormDefaults,
    property_ids: ["prop-1"],
    tenant_id: "tenant-1",
    units: [{ unit_id: "unit-1", monthly_amount: 350 }],
    start_date: "2026-01-01",
    end_date: "2028-12-31",
    ...overrides,
  };
}

/**
 * قيمة السماح الافتراضية في نموذج العقد.
 *
 * Owner decision 2026-10-20: a new contract starts with a one-day grace
 * period, matching the column default moved in migration 249. An invoice due
 * on day D is therefore still `due` on D+1 and becomes `overdue` on D+2.
 */
describe("contractFormDefaults", () => {
  test("starts a new contract with a one-day grace period", () => {
    expect(contractFormDefaults.grace_days).toBe(1);
  });
});

describe("contractFormSchema", () => {
  test("rejects a zero monthly amount", () => {
    const parsed = contractFormSchema.safeParse(
      validValues({
        units: [{ unit_id: "unit-1", monthly_amount: 0 }],
      }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.flatten().fieldErrors).toMatchObject({
      units: expect.anything(),
    });
    const monthly = parsed.error.issues.find((issue) => issue.path.includes("monthly_amount"));
    expect(monthly?.message).toBe("contracts.monthlyAmountPositive");
  });

  test("rejects a negative monthly amount", () => {
    const parsed = contractFormSchema.safeParse(
      validValues({
        units: [{ unit_id: "unit-1", monthly_amount: -10 }],
      }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const monthly = parsed.error.issues.find((issue) => issue.path.includes("monthly_amount"));
    expect(monthly?.message).toBe("contracts.monthlyAmountPositive");
  });

  test("accepts a zero deposit with a positive monthly amount", () => {
    const parsed = contractFormSchema.safeParse(validValues({ deposit: 0 }));
    expect(parsed.success).toBe(true);
  });
});

const CATEGORY = "3f1e0b1a-2c4d-4e6f-8a90-1b2c3d4e5f60";

describe("contractFormSchema extra charges", () => {
  test("accepts a contract with no extra charges at all", () => {
    expect(contractFormSchema.safeParse(validValues({ extra_charges: [] })).success).toBe(true);
  });

  test("accepts a categorised positive charge", () => {
    const parsed = contractFormSchema.safeParse(
      validValues({ extra_charges: [{ category_id: CATEGORY, amount: 100 }] }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.extra_charges).toEqual([{ category_id: CATEGORY, amount: 100 }]);
  });

  test("coerces the amount from the string an HTML number input actually submits", () => {
    const parsed = contractFormSchema.safeParse(
      validValues({
        extra_charges: [{ category_id: CATEGORY, amount: "100.5" as unknown as number }],
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.extra_charges[0].amount).toBe(100.5);
  });

  // A 0.000 line would be added to every invoice for the whole term — visible on
  // the PDF, meaning nothing, indistinguishable from a data-entry slip.
  test.each([0, -50])("rejects an amount of %d", (amount) => {
    const parsed = contractFormSchema.safeParse(
      validValues({ extra_charges: [{ category_id: CATEGORY, amount }] }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.includes("amount"));
    expect(issue?.message).toBe("contracts.extraChargeAmountPositive");
  });

  test("rejects a charge with no category chosen", () => {
    // The half-filled row the form starts every new charge as. It must not
    // reach the RPC, where an empty string fails the uuid cast.
    const parsed = contractFormSchema.safeParse(
      validValues({ extra_charges: [{ category_id: "", amount: 100 }] }),
    );
    expect(parsed.success).toBe(false);
  });
});

/**
 * نفس الجمع الذي تجريه قاعدة البيانات عند توليد الفاتورة.
 *
 * The worked example from the request: 1,000 rent plus a 100 cleaning charge
 * invoices at 1,100. The form shows this figure before saving and the database
 * computes it again at generation time, so the two must agree by construction
 * rather than by coincidence.
 */
describe("monthlyInvoiceTotal", () => {
  test("adds the extra charges to the rent", () => {
    expect(monthlyInvoiceTotal([{ monthly_amount: 1000 }], [{ amount: 100 }])).toBe(1100);
  });

  test("sums every unit and every charge, not just the first of each", () => {
    expect(
      monthlyInvoiceTotal(
        [{ monthly_amount: 1000 }, { monthly_amount: 250 }],
        [{ amount: 100 }, { amount: 30 }],
      ),
    ).toBe(1380);
  });

  test("is the rent alone when there are no extra charges", () => {
    expect(monthlyInvoiceTotal([{ monthly_amount: 1000 }], [])).toBe(1000);
  });

  test("treats an unparseable amount as zero rather than producing NaN", () => {
    // The amount is a string until submit, and an empty input parses to NaN —
    // which would render the whole total as "NaN KWD" while the operator types.
    expect(monthlyInvoiceTotal([{ monthly_amount: 1000 }], [{ amount: Number.NaN }])).toBe(1000);
  });

  test("is zero for an empty contract", () => {
    expect(monthlyInvoiceTotal([], [])).toBe(0);
  });
});

describe("resolveContractFormValues extra charges", () => {
  const editing = {
    id: "contract-1",
    tenant_id: "tenant-1",
    type: "investment" as const,
    state: "active" as const,
    commercial_activity: null,
    start_date: "2026-01-01",
    end_date: "2028-12-31",
    duration_months: 36,
    end_date_override_reason: null,
    due_day: 1,
    grace_days: 0,
    deposit: 0,
    notes: null,
    units: [
      {
        unit: { id: "unit-1", property_id: "prop-1" },
        monthlyAmount: 1000,
      },
    ],
  } as unknown as Parameters<typeof resolveContractFormValues>[0];

  test("prefills the charges the contract already bills", () => {
    const values = resolveContractFormValues(editing, [{ category_id: CATEGORY, amount: 100 }]);
    expect(values.extra_charges).toEqual([{ category_id: CATEGORY, amount: 100 }]);
  });

  test("copies the rows rather than aliasing the query's cached array", () => {
    // React Query hands back the same object on every render. Editing an
    // amount in the form must not mutate the cache, or cancelling the dialog
    // would leave the "existing" charges already changed.
    const cached = [{ category_id: CATEGORY, amount: 100 }];
    const values = resolveContractFormValues(editing, cached);
    values.extra_charges[0].amount = 999;
    expect(cached[0].amount).toBe(100);
  });

  test("a new contract starts with none", () => {
    expect(resolveContractFormValues(null).extra_charges).toEqual([]);
  });
});

describe("buildContractSavePayload", () => {
  test("drops a charge row whose category was never chosen", () => {
    // The shape the form starts every new charge as. Sent through, its empty
    // string fails the RPC's uuid cast and the whole save is refused — after
    // the operator has already filled the rest of the dialog in.
    const { contract } = buildContractSavePayload(
      validValues({
        extra_charges: [
          { category_id: "", amount: 0 },
          { category_id: CATEGORY, amount: 100 },
        ],
      }),
    );

    expect(contract.extra_charges).toEqual([{ category_id: CATEGORY, amount: 100 }]);
  });

  test("sends an empty array when the operator removed every charge", () => {
    // NOT an omitted key: the RPC treats absent as "leave them alone" and empty
    // as "there are none", so clearing the last charge has to send `[]` or it
    // would silently keep billing it.
    const { contract } = buildContractSavePayload(validValues({ extra_charges: [] }));
    expect(contract.extra_charges).toEqual([]);
  });

  test("clears the override reason once the end date matches the calculated one", () => {
    const values = validValues({
      start_date: "2026-01-01",
      duration_months: 36,
      end_date: calculatedEndDate("2026-01-01", 36),
      end_date_override_reason: "left over from an earlier override",
    });

    expect(buildContractSavePayload(values).contract.end_date_override_reason).toBeNull();
  });

  test("keeps the override reason while the end date really is overridden", () => {
    const values = validValues({
      start_date: "2026-01-01",
      duration_months: 36,
      end_date: "2030-06-30",
      end_date_override_reason: "  agreed with the tenant  ",
    });

    expect(buildContractSavePayload(values).contract.end_date_override_reason).toBe(
      "agreed with the tenant",
    );
  });

  test("writes null, not the sentinel, when no commercial activity is chosen", () => {
    const { contract } = buildContractSavePayload(
      validValues({ commercial_activity: NO_COMMERCIAL_ACTIVITY }),
    );
    expect(contract.commercial_activity).toBeNull();
  });

  test("carries the unit rows through unchanged", () => {
    const { units } = buildContractSavePayload(
      validValues({
        units: [
          { unit_id: "unit-1", monthly_amount: 350 },
          { unit_id: "unit-2", monthly_amount: 400 },
        ],
      }),
    );
    expect(units).toEqual([
      { unit_id: "unit-1", monthly_amount: 350 },
      { unit_id: "unit-2", monthly_amount: 400 },
    ]);
  });
});

/**
 * Codex review of PR #164, P1. When the charges query exhausts its retries,
 * `isLoading` goes false while `data` stays undefined. A guard that waited on
 * the wrong one of those prefilled the form with `[]` — and saving any other
 * field then sent that empty array, which the RPC reads as "there are none"
 * and deletes every charge the contract had.
 */
describe("buildContractSavePayload when the charges are unknown", () => {
  test("omits the key entirely rather than sending an empty array", () => {
    const { contract } = buildContractSavePayload(validValues({ extra_charges: [] }), false);

    // `in`, not a truthiness check: `extra_charges: []` is present-and-empty,
    // which is the destructive request this exists to avoid making.
    expect("extra_charges" in contract).toBe(false);
  });

  test("omits it even when the form is holding charges it cannot trust", () => {
    const { contract } = buildContractSavePayload(
      validValues({ extra_charges: [{ category_id: CATEGORY, amount: 100 }] }),
      false,
    );

    expect("extra_charges" in contract).toBe(false);
  });

  test("sends them normally once they are known", () => {
    const { contract } = buildContractSavePayload(
      validValues({ extra_charges: [{ category_id: CATEGORY, amount: 100 }] }),
      true,
    );

    expect(contract.extra_charges).toEqual([{ category_id: CATEGORY, amount: 100 }]);
  });

  test("defaults to known, so existing callers keep managing the charges", () => {
    expect("extra_charges" in buildContractSavePayload(validValues()).contract).toBe(true);
  });
});

describe("buildContractSavePayload suppress_tenant_billing_docs", () => {
  test("carries the suppress flag when enabled", () => {
    const { contract } = buildContractSavePayload(
      validValues({ suppress_tenant_billing_docs: true }),
    );
    expect(contract.suppress_tenant_billing_docs).toBe(true);
  });

  test("carries the suppress flag when disabled", () => {
    const { contract } = buildContractSavePayload(
      validValues({ suppress_tenant_billing_docs: false }),
    );
    expect(contract.suppress_tenant_billing_docs).toBe(false);
  });

  test("defaults to false for a new contract", () => {
    const { contract } = buildContractSavePayload(validValues());
    expect(contract.suppress_tenant_billing_docs).toBe(false);
  });

  test("re-prefills the flag from an existing contract", () => {
    const editing = {
      id: "contract-1",
      tenant_id: "tenant-1",
      type: "investment" as const,
      state: "active" as const,
      commercial_activity: null,
      start_date: "2026-01-01",
      end_date: "2028-12-31",
      duration_months: 36,
      end_date_override_reason: null,
      due_day: 1,
      grace_days: 0,
      deposit: 0,
      notes: null,
      suppress_tenant_billing_docs: true,
      units: [{ unit: { id: "unit-1", property_id: "prop-1" }, monthlyAmount: 1000 }],
    } as unknown as Parameters<typeof resolveContractFormValues>[0];
    const values = resolveContractFormValues(editing);
    expect(values.suppress_tenant_billing_docs).toBe(true);
    expect(buildContractSavePayload(values).contract.suppress_tenant_billing_docs).toBe(true);
  });
});

describe("contractFormSchema increase", () => {
  test("increase: percent above 100 is rejected, fixed is not capped, null is fine", () => {
    const base = validValues();
    expect(
      contractFormSchema.safeParse({
        ...base,
        increase: { after_years: 1, type: "percent", value: 150 },
      }).success,
    ).toBe(false);
    expect(
      contractFormSchema.safeParse({
        ...base,
        increase: { after_years: 1, type: "fixed", value: 150 },
      }).success,
    ).toBe(true);
    expect(contractFormSchema.safeParse({ ...base, increase: null }).success).toBe(true);
  });

  test("a percent above 100 fails with the percentCap message key on value", () => {
    const parsed = contractFormSchema.safeParse({
      ...validValues(),
      increase: { after_years: 1, type: "percent", value: 101 },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.find((issue) => issue.path.includes("value"))?.message).toBe(
      "contracts.increase.percentCap",
    );
  });
});

describe("buildContractSavePayload increase", () => {
  test("flattens the increase and clears it when null", () => {
    const values = {
      ...contractFormDefaults,
      increase: { after_years: 2, type: "fixed" as const, value: 50 },
    };
    expect(buildContractSavePayload(values).contract).toMatchObject({
      increase_after_years: 2,
      increase_type: "fixed",
      increase_value: 50,
    });
    expect(
      buildContractSavePayload({ ...contractFormDefaults, increase: null }).contract,
    ).toMatchObject({ increase_after_years: null, increase_type: null, increase_value: null });
  });
});

describe("resolveContractFormValues increase", () => {
  test("maps an editing contract's columns back into the increase trio", () => {
    const editing = {
      id: "contract-1",
      tenant_id: "tenant-1",
      type: "investment" as const,
      state: "active" as const,
      commercial_activity: null,
      start_date: "2026-01-01",
      end_date: "2028-12-31",
      duration_months: 36,
      end_date_override_reason: null,
      due_day: 1,
      grace_days: 0,
      deposit: 0,
      notes: null,
      increase_after_years: 2,
      increase_type: "percent",
      increase_value: 10,
      units: [{ unit: { id: "unit-1", property_id: "prop-1" }, monthlyAmount: 1000 }],
    } as unknown as Parameters<typeof resolveContractFormValues>[0];
    expect(resolveContractFormValues(editing).increase).toEqual({
      after_years: 2,
      type: "percent",
      value: 10,
    });
  });

  test("a contract without an increase prefills null, and so does a new one", () => {
    const editing = {
      id: "contract-1",
      tenant_id: "tenant-1",
      type: "investment" as const,
      state: "active" as const,
      commercial_activity: null,
      start_date: "2026-01-01",
      end_date: "2028-12-31",
      duration_months: 36,
      end_date_override_reason: null,
      due_day: 1,
      grace_days: 0,
      deposit: 0,
      notes: null,
      units: [{ unit: { id: "unit-1", property_id: "prop-1" }, monthlyAmount: 1000 }],
    } as unknown as Parameters<typeof resolveContractFormValues>[0];
    expect(resolveContractFormValues(editing).increase).toBeNull();
    expect(resolveContractFormValues(null).increase).toBeNull();
  });
});
