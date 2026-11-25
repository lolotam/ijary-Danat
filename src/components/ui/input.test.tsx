import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Input } from "./input";

describe("Input", () => {
  // A phone number, email address or URL is Latin/numeric whatever the page
  // language, so on an Arabic form it must not inherit RTL. This was originally
  // only true for `tel`, which left an email field rendering right-aligned
  // directly beneath a left-aligned phone field.
  test.each(["tel", "email", "url"])("uses left-to-right direction for %s entry", (type) => {
    expect(renderToStaticMarkup(<Input type={type} />)).toContain('dir="ltr"');
  });

  test.each(["text", "password", "search"])("leaves %s to inherit the page direction", (type) => {
    expect(renderToStaticMarkup(<Input type={type} />)).not.toContain('dir="ltr"');
  });

  test("an untyped input inherits the page direction", () => {
    expect(renderToStaticMarkup(<Input />)).not.toContain('dir="ltr"');
  });

  test("an explicit direction always wins", () => {
    expect(renderToStaticMarkup(<Input type="tel" dir="rtl" />)).toContain('dir="rtl"');
    expect(renderToStaticMarkup(<Input type="email" dir="rtl" />)).toContain('dir="rtl"');
  });
});
