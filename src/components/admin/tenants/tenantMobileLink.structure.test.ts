import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن الرقم المعروض في جدول المستأجرين هو نفسه الرقم الذي يفتحه الرابط.
 *
 * Review finding on PR #198: the cell showed `tenant.mobile` while the link
 * opened `tenant.whatsapp ?? tenant.mobile`. Where a tenant has both and they
 * differ, an admin clicks a visible number and lands in a different person's
 * thread — a wrong-recipient bug that no type or render check would catch,
 * because both fields are strings and both render fine.
 */
const source = readFileSync(
  resolve(process.cwd(), "src/components/admin/tenants/TenantsTable.tsx"),
  "utf8",
);

describe("tenant mobile cell", () => {
  test("links the number it displays", () => {
    const cell = source.slice(
      source.indexOf("function TenantMobileValue"),
      source.indexOf("export type TenantsTableProps"),
    );
    expect(cell).toMatch(/phone=\{tenant\.mobile\}/);
    expect(cell).not.toMatch(/phone=\{tenant\.whatsapp/);
  });

  test("keeps row activation from swallowing the link", () => {
    // The row navigates on click and on Enter; without this the keyboard path
    // reaches the tenant page and never the chat.
    expect(source).toMatch(/stopRowActivation/);
  });
});
