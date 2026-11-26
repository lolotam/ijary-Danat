import { describe, expect, test } from "vitest";

import { CompanyContextError } from "@/company/errors";
import {
  assertStorageCompanyId,
  companyStoragePath,
  extractCompanyIdFromStoragePath,
} from "@/company/storagePath";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

describe("companyStoragePath", () => {
  test("prefixes relative path with companies/<companyId>/", () => {
    expect(companyStoragePath(COMPANY_A, "tenants/t1/doc.pdf")).toBe(
      `companies/${COMPANY_A}/tenants/t1/doc.pdf`,
    );
    expect(companyStoragePath(COMPANY_A, "/branding/logo.png")).toBe(
      `companies/${COMPANY_A}/branding/logo.png`,
    );
  });

  test("is idempotent when path already belongs to the same company", () => {
    expect(companyStoragePath(COMPANY_A, `companies/${COMPANY_A}/backups/1.zip`)).toBe(
      `companies/${COMPANY_A}/backups/1.zip`,
    );
  });

  test("rejects missing or invalid company ids with COMPANY_REQUIRED", () => {
    expect(() => companyStoragePath("", "a/b.pdf")).toThrow(CompanyContextError);
    expect(() => companyStoragePath("unassigned", "a/b.pdf")).toThrow(
      /Company context is required/i,
    );
    expect(() => assertStorageCompanyId(null)).toThrow(CompanyContextError);
  });

  test("rejects cross-company prefixes and path traversal segments", () => {
    expect(() => companyStoragePath(COMPANY_A, `companies/${COMPANY_B}/a/b.pdf`)).toThrow(
      /Cross-company storage path rejected/i,
    );
    expect(() => companyStoragePath(COMPANY_A, "../secret.pdf")).toThrow(/traversal/i);
    expect(() => companyStoragePath(COMPANY_A, "a/../b.pdf")).toThrow(/traversal/i);
    expect(() => companyStoragePath(COMPANY_A, "")).toThrow(/required/i);
  });

  test("extractCompanyIdFromStoragePath extracts UUID prefix when present", () => {
    expect(extractCompanyIdFromStoragePath(`companies/${COMPANY_A}/tenants/t1/a.pdf`)).toBe(
      COMPANY_A,
    );
    expect(extractCompanyIdFromStoragePath("legacy/tenants/t1/a.pdf")).toBeNull();
    expect(extractCompanyIdFromStoragePath(null)).toBeNull();
  });
});
