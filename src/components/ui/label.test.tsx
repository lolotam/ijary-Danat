import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Label } from "./label";

/**
 * An admin filling the contract or tenant form could not tell which fields were
 * mandatory until submit rejected them. The asterisk is the fix; these tests pin
 * the two things about it that are easy to get wrong in a bilingual RTL product.
 */
describe("Label", () => {
  test("no asterisk unless the field is required", () => {
    // Optional fields get nothing at all — that was the explicit request.
    expect(renderToStaticMarkup(<Label>الاسم</Label>)).not.toContain("*");
  });

  test("required renders a red asterisk", () => {
    const html = renderToStaticMarkup(<Label required>الاسم</Label>);
    expect(html).toContain("*");
    expect(html).toContain("text-destructive");
  });

  test("the asterisk is a sibling node, not part of the translated text", () => {
    // Appending "*" to the t() string would let the bidi algorithm place the
    // star on whichever side it liked — the wrong one about half the time in
    // Arabic. A separate element with a logical margin cannot drift.
    const html = renderToStaticMarkup(<Label required>الاسم</Label>);
    expect(html).toMatch(/الاسم<span[^>]*>\*<\/span>/);
    expect(html).toContain("ms-1");
  });

  test("the asterisk is hidden from screen readers", () => {
    // aria-required on the control carries this for assistive tech; hearing
    // "star" before every mandatory field is noise.
    expect(renderToStaticMarkup(<Label required>الاسم</Label>)).toMatch(
      /<span[^>]*aria-hidden="true"/,
    );
  });

  test("children still render when nothing is required", () => {
    expect(renderToStaticMarkup(<Label>Monthly rent</Label>)).toContain("Monthly rent");
  });
});
