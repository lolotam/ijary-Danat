/**
 * منطق نموذج طلب الصيانة: تحويل الصف إلى نموذج، والنموذج إلى حمولة.
 *
 * Radix Select forbids an empty value, so the form carries "none" for an
 * unset building or unit. The rule worth pinning is that "none" never
 * reaches the database — it must become null — and that a saved row
 * round-trips through the form unchanged.
 */
import { describe, expect, it } from "vitest";

import {
  maintenanceDefaults,
  maintenancePayload,
  maintenanceSchema,
  maintenanceToForm,
} from "@/lib/maintenanceForm";

describe("maintenancePayload", () => {
  it('turns "none" building and unit into null, and a blank description into null', () => {
    expect(
      maintenancePayload({
        ...maintenanceDefaults,
        property_id: "prop-1",
        title: "Leak",
        description: "   ",
      }),
    ).toEqual({
      property_id: "prop-1",
      building_id: null,
      unit_id: null,
      title: "Leak",
      description: null,
      priority: "medium",
      status: "open",
    });
  });

  it("keeps real building and unit ids", () => {
    const payload = maintenancePayload({
      ...maintenanceDefaults,
      property_id: "prop-1",
      building_id: "bld-1",
      unit_id: "unit-1",
      title: "Leak",
    });
    expect(payload).toMatchObject({ building_id: "bld-1", unit_id: "unit-1" });
  });
});

describe("maintenanceToForm", () => {
  it("round-trips a saved row through the form", () => {
    const row = {
      property_id: "prop-1",
      building_id: null,
      unit_id: "unit-1",
      title: "Leak",
      description: null,
      priority: "urgent",
      status: "in_progress",
    } as never;

    const form = maintenanceToForm(row);

    expect(form).toMatchObject({ building_id: "none", unit_id: "unit-1", description: "" });
    expect(maintenancePayload(form)).toEqual({
      property_id: "prop-1",
      building_id: null,
      unit_id: "unit-1",
      title: "Leak",
      description: null,
      priority: "urgent",
      status: "in_progress",
    });
  });
});

describe("maintenanceSchema", () => {
  it("requires a property and a non-blank title", () => {
    expect(maintenanceSchema.safeParse(maintenanceDefaults).success).toBe(false);
    expect(
      maintenanceSchema.safeParse({ ...maintenanceDefaults, property_id: "p", title: "  " })
        .success,
    ).toBe(false);
    expect(
      maintenanceSchema.safeParse({ ...maintenanceDefaults, property_id: "p", title: "Leak" })
        .success,
    ).toBe(true);
  });
});
