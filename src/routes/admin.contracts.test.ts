import { describe, expect, test } from "vitest";

import { dictionaries } from "@/i18n/dictionary";

describe("contracts past-end confirm i18n", () => {
  const keys = [
    "contracts.pastEndConfirmTitle",
    "contracts.pastEndConfirmDescription",
    "contracts.pastEndConfirmDescriptionNoUnit",
  ] as const;

  test.each(keys)("%s exists in ar and en and the locales differ", (key) => {
    const ar = dictionaries.ar[key];
    const en = dictionaries.en[key];
    expect(ar, `missing ar key ${key}`).toBeTruthy();
    expect(en, `missing en key ${key}`).toBeTruthy();
    expect(ar).not.toBe(en);
  });

  test("unit-bearing description has {unit}; no-unit variant does not", () => {
    expect(dictionaries.en["contracts.pastEndConfirmDescription"]).toContain("{unit}");
    expect(dictionaries.ar["contracts.pastEndConfirmDescription"]).toContain("{unit}");
    expect(dictionaries.en["contracts.pastEndConfirmDescriptionNoUnit"]).not.toContain("{unit}");
    expect(dictionaries.ar["contracts.pastEndConfirmDescriptionNoUnit"]).not.toContain("{unit}");
  });

  test("removed silent-coercion key is gone from both locales", () => {
    expect(dictionaries.ar["contracts.activeNotAllowedForPastEnd"]).toBeUndefined();
    expect(dictionaries.en["contracts.activeNotAllowedForPastEnd"]).toBeUndefined();
  });
});
