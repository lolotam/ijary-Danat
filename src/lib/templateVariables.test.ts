import { describe, expect, test } from "vitest";

import { FREE_TEXT_VARIABLES, TEMPLATE_VARIABLES, sampleVariablesFor } from "./templateVariables";

describe("FREE_TEXT_VARIABLES", () => {
  test("disambiguates the two different amounts", () => {
    // `amount` is the invoice balance in resolveDueReminderVariables and the
    // payment amount in resolveReceiptVariables. Offered under one key, one wins
    // silently and the admin cannot tell which value they just inserted.
    const keys = FREE_TEXT_VARIABLES.map((spec) => spec.key);

    expect(keys).toContain("invoice_amount");
    expect(keys).toContain("payment_amount");
    expect(keys).not.toContain("amount");
  });

  test("declares no key twice", () => {
    // A duplicate would render two chips inserting the same placeholder, and the
    // second would look like a different variable.
    const keys = FREE_TEXT_VARIABLES.map((spec) => spec.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("gives every entry both labels and a sample", () => {
    // The chip row renders labelAr or labelEn by locale; a blank one is an
    // unreadable button.
    for (const spec of FREE_TEXT_VARIABLES) {
      expect(spec.labelAr.trim(), spec.key).not.toBe("");
      expect(spec.labelEn.trim(), spec.key).not.toBe("");
      expect(spec.sample.trim(), spec.key).not.toBe("");
    }
  });
});

describe("TEMPLATE_VARIABLES", () => {
  test("every type with a sender has variables declared", () => {
    // The editor lists these and the preview substitutes them. A type missing
    // here shows an admin no placeholders at all.
    for (const type of [
      "receipt",
      "overdue_reminder",
      "contract_expiry",
      "document_send",
      "deposit_confirmation",
      "payment_admin_alert",
      "user_credentials",
      "contract_closeout",
      "contract_restored",
      "invoice_written_off",
      "invoice_disputed",
      "company_info",
      "whatsapp_session_alert",
    ] as const) {
      expect(TEMPLATE_VARIABLES[type]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("every variable carries both locale labels and a sample", () => {
    for (const specs of Object.values(TEMPLATE_VARIABLES)) {
      for (const spec of specs ?? []) {
        expect(spec.labelAr.length).toBeGreaterThan(0);
        expect(spec.labelEn.length).toBeGreaterThan(0);
        expect(spec.sample.length).toBeGreaterThan(0);
      }
    }
  });

  test("keys are snake_case, matching the {{placeholder}} convention", () => {
    for (const specs of Object.values(TEMPLATE_VARIABLES)) {
      for (const spec of specs ?? []) expect(spec.key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test("company_info lists the placeholders the seed and sender fill", () => {
    const keys = (TEMPLATE_VARIABLES.company_info ?? []).map((spec) => spec.key);
    expect(keys).toEqual(["tenant_name", "company_name"]);
  });

  test("sampleVariablesFor returns a flat key/value map", () => {
    const samples = sampleVariablesFor("receipt");
    expect(samples.tenant_name).toBeTruthy();
    expect(typeof samples.amount).toBe("string");
  });
});
