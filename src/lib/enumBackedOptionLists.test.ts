import { describe, expect, test } from "vitest";

import {
  ENUM_BACKED_OPTION_LISTS,
  isEnumBackedOptionList,
  validateOptionListItemValue,
} from "@/lib/enumBackedOptionLists";

describe("validateOptionListItemValue", () => {
  test("enum-backed list + invalid value → rejected with allowed members", () => {
    const result = validateOptionListItemValue("contract_states", "not_a_state");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.allowed).toEqual(ENUM_BACKED_OPTION_LISTS.contract_states);
      expect(result.allowed).toContain("active");
      expect(result.allowed).not.toContain("not_a_state");
    }
  });

  test("enum-backed list + valid member → accepted", () => {
    expect(validateOptionListItemValue("unit_statuses", "vacant")).toEqual({ ok: true });
    expect(validateOptionListItemValue("payment_methods", "knet")).toEqual({ ok: true });
    expect(validateOptionListItemValue("contract_types", "lease")).toEqual({ ok: true });
    expect(validateOptionListItemValue("tenant_lifecycles", "blocked")).toEqual({ ok: true });
  });

  test("free-text list + arbitrary value → accepted", () => {
    // unit_types / property_types are free text after migration 103.
    expect(validateOptionListItemValue("unit_types", "commercial_unit")).toEqual({ ok: true });
    expect(validateOptionListItemValue("property_types", "mall")).toEqual({ ok: true });
    expect(validateOptionListItemValue("commercial_activities", "electronics")).toEqual({
      ok: true,
    });
    expect(validateOptionListItemValue("unit_floors", "mezzanine")).toEqual({ ok: true });
    expect(validateOptionListItemValue("gmail_categories", "anything_goes")).toEqual({ ok: true });
    expect(validateOptionListItemValue("tenant_categories", "platinum")).toEqual({ ok: true });
  });

  test("trims value before enum membership check", () => {
    expect(validateOptionListItemValue("contract_states", "  active  ")).toEqual({ ok: true });
  });
});

describe("isEnumBackedOptionList", () => {
  test("known enum-backed codes", () => {
    expect(isEnumBackedOptionList("contract_states")).toBe(true);
    expect(isEnumBackedOptionList("unit_statuses")).toBe(true);
  });

  test("free-text codes", () => {
    expect(isEnumBackedOptionList("unit_types")).toBe(false);
    expect(isEnumBackedOptionList("property_types")).toBe(false);
  });
});
