import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { TemplateOptionLabel } from "./TemplateOptionLabel";

/**
 * تتحقّق من أن التسمية تتبع لغة الرسالة لا لغة الواجهة، ومن عزل الاتجاه.
 *
 * The suite runs on `environment: "node"` with no DOM (vitest.config.ts), so
 * these assert the RENDERED MARKUP — which is exactly where both requirements
 * live: which language the type name comes out in, and whether the Latin code is
 * direction-isolated from the Arabic text beside it.
 *
 * Deliberately NOT wrapped in I18nProvider: the point of this component is that
 * it does not read the ambient UI locale. Rendering it bare proves that — if it
 * ever switched to `useI18n().t`, these tests would throw or fall back rather
 * than quietly render the admin's language to a tenant.
 */
describe("TemplateOptionLabel", () => {
  test("renders the type name in Arabic when the message locale is Arabic", () => {
    const html = renderToStaticMarkup(
      <TemplateOptionLabel code="receipt" type="receipt" locale="ar" />,
    );

    expect(html).toContain("receipt");
    expect(html).toContain("إيصال");
  });

  test("renders the type name in English when the message locale is English", () => {
    const html = renderToStaticMarkup(
      <TemplateOptionLabel code="receipt" type="receipt" locale="en" />,
    );

    expect(html).toContain("Receipt");
    expect(html).not.toContain("إيصال");
  });

  // The same component, the same code, two different message locales: this pair
  // is the whole feature. A regression to the UI-bound translator would make
  // both cases render identically.
  test("the two locales do not render the same markup", () => {
    const ar = renderToStaticMarkup(
      <TemplateOptionLabel code="contract-expiry" type="contract_expiry" locale="ar" />,
    );
    const en = renderToStaticMarkup(
      <TemplateOptionLabel code="contract-expiry" type="contract_expiry" locale="en" />,
    );

    expect(ar).not.toBe(en);
  });

  test("isolates the Latin code so it cannot reorder inside an RTL dialog", () => {
    const html = renderToStaticMarkup(
      <TemplateOptionLabel code="deposit-confirmation" type="deposit_confirmation" locale="ar" />,
    );

    // The code is forced LTR; the type sits in its own isolate so the closing
    // parenthesis cannot jump to the other end of the line.
    expect(html).toContain('<bdi dir="ltr">deposit-confirmation</bdi>');
    expect(html.match(/<bdi/g)).toHaveLength(2);
  });
});
