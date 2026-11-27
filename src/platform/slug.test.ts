import { describe, expect, it } from "vitest";

import { assertValidCompanySlug, SLUG_INVALID } from "./slug";

/** المعرّفات التي تقبلها قاعدة البيانات: `companies_slug_format` في الترحيل 254. */
const ACCEPTED_SLUGS = ["abc", "a-b", "acme-2024", "ab1", "a".repeat(32)];

/** المعرّفات التي يرفضها الشكل، وسبب كل رفض. */
const REFUSED_SLUGS = [
  ["an empty name", ""],
  ["two characters", "ab"],
  ["an upper-case letter", "Acme"],
  ["a trailing hyphen", "acme-"],
  ["a leading hyphen", "-acme"],
  ["an underscore", "acme_1"],
  ["a space", "acme 1"],
  ["a non-ASCII letter", "acmeé"],
  ["thirty-three characters", "a".repeat(33)],
] as const;

describe("assertValidCompanySlug", () => {
  it.each(ACCEPTED_SLUGS)("accepts %s", (slug) => {
    expect(() => assertValidCompanySlug(slug)).not.toThrow();
  });

  it.each(REFUSED_SLUGS)("refuses %s with SLUG_INVALID", (_label, slug) => {
    expect(() => assertValidCompanySlug(slug)).toThrow(SLUG_INVALID);
  });
});
