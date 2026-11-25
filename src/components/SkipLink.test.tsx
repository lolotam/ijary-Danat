import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SkipLink } from "./SkipLink";

describe("SkipLink", () => {
  test("links keyboard users to the primary page content", () => {
    const markup = renderToStaticMarkup(<SkipLink />);

    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain("تجاوز إلى المحتوى / Skip to content");
  });
});
