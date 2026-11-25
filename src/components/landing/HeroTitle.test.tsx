import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeroTitle } from "./HeroTitle";

describe("HeroTitle", () => {
  it("renders one h1 with the title, the slow fade class, and no cursor span", () => {
    const markup = renderToStaticMarkup(<HeroTitle title="دانة المستقبل" />);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("دانة المستقبل");
    expect(markup).toContain("animate-fade-in-slow");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).not.toContain("animate-pulse");
  });
});
