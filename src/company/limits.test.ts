import { describe, expect, test } from "vitest";

import { CompanyContextError } from "@/company/errors";
import {
  LIMIT_ERROR_CODES,
  LIMIT_I18N_KEYS,
  limitErrorCode,
  limitErrorKey,
  type LimitErrorCode,
} from "@/company/limits";
import { limits as arLimits } from "@/i18n/locales/ar/limits";
import { limits as enLimits } from "@/i18n/locales/en/limits";

describe("limitErrorCode and limitErrorKey", () => {
  test.each<{
    label: string;
    input: unknown;
    expected: LimitErrorCode | null;
  }>([
    {
      label: "extracts code from Error message",
      input: new Error("Failed to insert unit: LIMIT_UNITS"),
      expected: "LIMIT_UNITS",
    },
    {
      label: "extracts code from PostgREST error object",
      input: { message: "LIMIT_STAFF", details: null, hint: null, code: "P0001" },
      expected: "LIMIT_STAFF",
    },
    {
      label: "extracts code from error details when message is generic",
      input: { message: "Database error", details: "Hit LIMIT_STORAGE quota" },
      expected: "LIMIT_STORAGE",
    },
    {
      label: "extracts code from CompanyContextError",
      input: new CompanyContextError("LIMIT_WHATSAPP"),
      expected: "LIMIT_WHATSAPP",
    },
    {
      label: "extracts code from plain string",
      input: "LIMIT_UNITS",
      expected: "LIMIT_UNITS",
    },
    {
      label: "returns null for unrelated errors",
      input: new Error("duplicate key value violates unique constraint"),
      expected: null,
    },
    {
      label: "returns null for non-limit CompanyContextError",
      input: new CompanyContextError("COMPANY_SUSPENDED"),
      expected: null,
    },
    {
      label: "returns null for nullish or non-string values",
      input: null,
      expected: null,
    },
  ])("$label", ({ input, expected }) => {
    expect(limitErrorCode(input)).toBe(expected);
    expect(limitErrorKey(input)).toBe(expected ? LIMIT_I18N_KEYS[expected] : null);
  });

  test.each(LIMIT_ERROR_CODES)("provides matching ar and en i18n copy for %s", (code) => {
    const key = LIMIT_I18N_KEYS[code];
    expect(key).toBe(`limits.${code}`);
    expect(enLimits[key]).toBeTruthy();
    expect(arLimits[key]).toBeTruthy();
  });
});
