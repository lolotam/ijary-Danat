import { describe, expect, test } from "vitest";

import { visibleLandingNavigation } from "./landingNavigation";

describe("visibleLandingNavigation", () => {
  test("omits links whose destination sections are disabled", () => {
    const visibleItems = visibleLandingNavigation((section) => section !== "gallery");

    expect(visibleItems.map(({ href }) => href)).toEqual([
      "#home",
      "#about",
      "#shops",
      "#location",
    ]);
  });
});
