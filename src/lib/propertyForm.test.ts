import { describe, expect, test } from "vitest";

import { propertyFormSchema } from "@/lib/propertyForm";

const validBase = {
  name_ar: "مجمع النخيل",
  name_en: "Palm Complex",
  paci_no: "",
  type: "compound",
  address_ar: "",
  address_en: "",
  location_url: "",
  area: undefined,
  floor_count: undefined,
  unit_count: undefined,
  description_ar: "",
  description_en: "",
  image_url: "",
  status: "active" as const,
};

describe("propertyFormSchema — paci_no and declared counts", () => {
  test("paci_no empty string parses", () => {
    const result = propertyFormSchema.safeParse({ ...validBase, paci_no: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paci_no).toBe("");
  });

  test("paci_no free text round-trips", () => {
    const result = propertyFormSchema.safeParse({ ...validBase, paci_no: "12345678" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paci_no).toBe("12345678");
  });

  test("empty floor_count and unit_count parse to undefined", () => {
    const result = propertyFormSchema.safeParse({
      ...validBase,
      floor_count: "",
      unit_count: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.floor_count).toBeUndefined();
      expect(result.data.unit_count).toBeUndefined();
    }
  });

  test('floor_count "0" parses to the number 0, not undefined', () => {
    // Zero is a real declared count; a truthy check would hide it on the detail page.
    const result = propertyFormSchema.safeParse({ ...validBase, floor_count: "0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.floor_count).toBe(0);
  });

  // Both counts share one schema helper, so both fields are exercised here —
  // testing only floor_count would leave unit_count's guard unproven.
  test.each([
    ["floor_count", "-1"],
    ["floor_count", "2.5"],
    ["unit_count", "-1"],
    ["unit_count", "2.5"],
  ] as const)("%s rejects %s — declared counts are whole and non-negative", (field, value) => {
    const result = propertyFormSchema.safeParse({ ...validBase, [field]: value });
    expect(result.success).toBe(false);
  });

  test("still rejects empty name_ar (move preserved existing contract)", () => {
    const result = propertyFormSchema.safeParse({ ...validBase, name_ar: "" });
    expect(result.success).toBe(false);
  });
});
