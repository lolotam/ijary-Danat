import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  test("falls back to both IJARY mark colourways, hiding the dark one in the light theme", () => {
    const markup = renderToStaticMarkup(<BrandLogo name="دانة المستقبل" subName="Danat Future" />);

    expect(markup).toMatch(
      /src="\/brand\/ijary-mark\.svg"[^>]*alt="دانة المستقبل"[^>]*dark:hidden/,
    );
    expect(markup).toMatch(/src="\/brand\/ijary-mark-on-dark\.svg"[^>]*hidden dark:block/);
    expect(markup).toContain("Danat Future");
  });

  test("uses only the on-dark mark on a dark panel", () => {
    const markup = renderToStaticMarkup(<BrandLogo name="IJARY" onDark />);

    expect(markup).toContain('src="/brand/ijary-mark-on-dark.svg"');
    expect(markup).not.toContain('src="/brand/ijary-mark.svg"');
  });
});
