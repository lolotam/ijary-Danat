import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن عدة جهات اتصال واتساب يمكنها الارتباط بنفس
 * المستأجر ونفس العقد — لا يوجد قيد unique يمنع ذلك.
 *
 * يقرأ ملفات الترحيل المُشحونة بدل محاكاة Postgres.
 */
const inboxMigration = readFileSync(
  resolve(process.cwd(), "db/migrations/180_whatsapp_inbox.sql"),
  "utf8",
);
const contractsMigration = readFileSync(
  resolve(process.cwd(), "db/migrations/186_whatsapp_contact_contracts.sql"),
  "utf8",
);

const inboxCode = inboxMigration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const contractsCode = contractsMigration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("whatsapp contacts multi-link to same tenant/contract", () => {
  test("whatsapp_contacts: الوحيد unique هو phone", () => {
    expect(inboxCode).toMatch(/phone\s+text\s+not\s+null\s+unique/i);
    // لا يوجد unique على tenant_id
    expect(inboxCode).not.toMatch(/tenant_id[^;]*unique/i);
  });

  test("whatsapp_contact_contracts: المفتاح الوحيد هو (contact_id, contract_id)", () => {
    expect(contractsCode).toMatch(/primary\s+key\s*\(\s*contact_id\s*,\s*contract_id\s*\)/i);
    expect(contractsCode).not.toMatch(/unique\s*\(\s*contract_id\s*\)/i);
    expect(contractsCode).not.toMatch(/unique\s*\(\s*tenant_id/i);
  });

  test("الوسيط fns/whatsappChat يحذف ثم يعيد إدخال الروابط (يسمح بأي عدد)", () => {
    const fn = readFileSync(resolve(process.cwd(), "src/fns/whatsappChat.ts"), "utf8");
    expect(fn).toMatch(/\.from\s*\(\s*"whatsapp_contact_contracts"\s*\)\s*\.delete\(\)/i);
    expect(fn).toMatch(/\.insert\s*\(\s*(data\.)?contractIds\.map/i);
  });
});
