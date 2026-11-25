import { describe, expect, test } from "vitest";

import {
  buildTenantSubmitPayload,
  resolveTenantFormValues,
  tenantFormDefaults,
  type TenantFormValues,
} from "@/lib/tenantForm";

/**
 * قيم نموذج صالحة لاختبار الحمولة دون ملء كل الحقول يدوياً في كل حالة.
 */
function filledValues(overrides: Partial<TenantFormValues> = {}): TenantFormValues {
  return {
    ...tenantFormDefaults,
    name: "أحمد",
    name_en: "Ahmad",
    owner_civil_id: "289123456789",
    commercial_name_ar: "شركة النور",
    commercial_name_en: "Al Noor Co",
    authorized_manager: "خالد",
    authorized_manager_civil_id: "280111222333",
    commercial_address: "السالمية، مجمع السلام",
    ...overrides,
  };
}

describe("buildTenantSubmitPayload", () => {
  test("writes the three new tenant columns and neither retired one", () => {
    const payload = buildTenantSubmitPayload(filledValues(), "company-1");

    expect(payload.owner_civil_id).toBe("289123456789");
    expect(payload.authorized_manager_civil_id).toBe("280111222333");
    expect(payload.commercial_address).toBe("السالمية، مجمع السلام");
    expect(payload).not.toHaveProperty("owner_name");
    expect(payload).not.toHaveProperty("alternate_contacts");
  });

  test("empty civil IDs and address become null, not empty strings", () => {
    const payload = buildTenantSubmitPayload(
      filledValues({
        owner_civil_id: "  ",
        authorized_manager_civil_id: "",
        commercial_address: "",
      }),
      null,
    );

    expect(payload.owner_civil_id).toBeNull();
    expect(payload.authorized_manager_civil_id).toBeNull();
    expect(payload.commercial_address).toBeNull();
  });

  test("a paused tenant stays paused through the reset and the submit payload", () => {
    const editing = { ...filledValues(), commercial_name: null, notifications_paused: true };

    const values = resolveTenantFormValues(editing);
    expect(values.notifications_paused).toBe(true);

    const payload = buildTenantSubmitPayload(values, "company-1");
    expect(payload.notifications_paused).toBe(true);
  });
});
