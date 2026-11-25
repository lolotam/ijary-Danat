import { describe, expect, test } from "vitest";

import { auditActionLabel, auditEntityLabel, auditRoleLabel } from "@/lib/auditLabels";

describe("auditActionLabel", () => {
  test("composes noun and verb in both locales", () => {
    expect(auditActionLabel("property.create", "ar")).toBe("إنشاء عقار");
    expect(auditActionLabel("property.create", "en")).toBe("Create property");
  });

  test("splits at the last dot so a dotted noun keeps its own entry", () => {
    expect(auditActionLabel("user.role.grant", "ar")).toBe("منح دور مستخدم");
  });

  test("a whole-code entry wins over composition", () => {
    expect(auditActionLabel("invoice.mark_paid", "ar")).toBe("تعليم فاتورة كمدفوعة");
  });

  test("an unknown code is shown raw rather than dropped", () => {
    expect(auditActionLabel("widget.frobnicate", "ar")).toBe("widget.frobnicate");
    expect(auditActionLabel("explode", "en")).toBe("explode");
    expect(auditActionLabel("tenant.frobnicate", "en")).toBe("tenant.frobnicate");
  });
});

describe("auditEntityLabel", () => {
  test("translates a known type and passes an unknown one through", () => {
    expect(auditEntityLabel("tenant", "ar")).toBe("مستأجر");
    expect(auditEntityLabel("mystery_table", "ar")).toBe("mystery_table");
  });
});

describe("auditRoleLabel", () => {
  test("reads app roles and Postgres roles from their own namespaces", () => {
    expect(auditRoleLabel("admin", "ar")).toBe("مدير");
    expect(auditRoleLabel("service_role", "en")).toBe("System (scheduled job)");
    expect(auditRoleLabel("custom_role_x", "en")).toBe("custom_role_x");
  });
});
