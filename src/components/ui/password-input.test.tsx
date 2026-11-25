import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PasswordInput } from "./password-input";
import { I18nProvider } from "@/i18n/provider";
import { dictionaries } from "@/i18n/dictionary";

/**
 * The suite runs on `environment: "node"` with no DOM (vitest.config.ts), so
 * these assert the RENDERED MARKUP of each starting state. Clicking the toggle
 * is not covered here and is checked in the browser instead — stated plainly
 * rather than faked with a test that re-implements useState.
 *
 * What the markup does prove is the pair most likely to be wrong: which `type`
 * each state renders, and that the accessible name describes the action the
 * button performs rather than the state it is in.
 */
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
}

describe("PasswordInput", () => {
  test("masks the value by default", () => {
    const html = render(<PasswordInput />);
    expect(html).toContain('type="password"');
    expect(html).not.toContain('type="text"');
  });

  test("defaultVisible starts revealed", () => {
    // The admin user forms rely on this: the password is generated for a human
    // to read and pass on. Masking them would regress a working flow.
    const html = render(<PasswordInput defaultVisible />);
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="password"');
  });

  test("the button offers the action, not the current state", () => {
    // Masked shows "Show password" (what clicking does), revealed shows "Hide".
    // Inverting these is the classic bug and markup is enough to catch it.
    expect(render(<PasswordInput />)).toContain(dictionaries.ar["auth.showPassword"]);
    expect(render(<PasswordInput defaultVisible />)).toContain(
      dictionaries.ar["auth.hidePassword"],
    );
  });

  test("the toggle never submits the form it sits in", () => {
    // A bare <button> defaults to type="submit"; both login pages would post on
    // every reveal.
    expect(render(<PasswordInput />)).toContain('type="button"');
  });

  test("direction is isolated on the wrapper, never on the input", () => {
    // The load-bearing detail. On the Arabic login pages the field is LTR while
    // the page is RTL; if the button inherited RTL, `end-2` would resolve to the
    // left edge and sit on top of the typed characters. ui/input.test.tsx pins
    // that a password input must not emit dir itself.
    const html = render(<PasswordInput dir="ltr" />);
    // Matched on the outer element rather than an exact class string, so
    // restyling the wrapper does not break a test about direction.
    expect(html).toMatch(/^<div [^>]*dir="ltr"/);
    expect(html).not.toMatch(/<input[^>]*dir=/);
  });

  test("no direction is forced when the caller does not ask for one", () => {
    // The tenant profile page inherits the page direction and must stay that way.
    expect(render(<PasswordInput />)).not.toContain("dir=");
  });
});
