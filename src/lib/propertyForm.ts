import { z } from "zod";

/** An untouched number input arrives as "" — that means absent, not zero. */
const blankToUndefined = (value: unknown) =>
  value === "" || value == null ? undefined : Number(value);

const optionalNumber = z.preprocess(blankToUndefined, z.number().nonnegative().optional());

/** Empty / null → undefined; otherwise a non-negative integer (rejects floats). */
const optionalPositiveInt = z.preprocess(
  blankToUndefined,
  z.number().nonnegative().int().optional(),
);

const required = z.string().trim().min(1);

/**
 * Shared property create/edit schema for the Properties section Add/Edit
 * dialog. Extracted from the route so tests can import it without tripping
 * react-refresh/only-export-components on a non-component route export.
 *
 * paci_no / floor_count / unit_count are declared reference attributes
 * (migration 104) — not derived unit counts or building floor totals.
 */
export const propertyFormSchema = z.object({
  name_ar: required,
  name_en: z.string(),
  paci_no: z.string(),
  // Free-text after migration 103; must be non-empty (empty selection fails).
  type: z.string().trim().min(1),
  address_ar: z.string(),
  address_en: z.string(),
  location_url: z.string().refine((v) => !v || /^https?:\/\//i.test(v), "Must be an http(s) URL"),
  area: optionalNumber,
  floor_count: optionalPositiveInt,
  unit_count: optionalPositiveInt,
  description_ar: z.string(),
  description_en: z.string(),
  image_url: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
});

export type PropertyFormValues = z.infer<typeof propertyFormSchema>;
