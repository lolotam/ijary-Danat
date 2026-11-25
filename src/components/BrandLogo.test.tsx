import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  test("renders the official mark with the supplied brand name", () => {
    const markup = renderToStaticMarkup(<BrandLogo name="دانة المستقبل" subName="Danat Future" />);

    expect(markup).toContain('src="/brand/logo.png"');
    expect(markup).toContain('alt="دانة المستقبل"');
    expect(markup).toContain("Danat Future");
  });
});
