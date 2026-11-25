import { describe, expect, test } from "vitest";

import { EMAIL_LOGO_MARKER } from "./emailTemplates";
import { applyEmailLogo } from "./emailLogo";
import {
  contractExpiryTemplate,
  depositConfirmationTemplate,
  invoiceDocumentTemplate,
  overdueReminderTemplate,
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
} from "./emailTemplates";
import { SEEDED_BODIES } from "./__fixtures__/seededBodies";
import { renderTemplate } from "./templateRender";
import { sampleVariablesFor } from "./templateVariables";

/**
 * Migration 70's whole safety claim is that the seeded bodies reproduce what the
 * builders produce today, so making templates authoritative changes no email
 * until an admin edits one.
 *
 * Nothing else checks that. If a hand-ported body drops the receipt's amounts
 * table, every other test in this piece still passes and the regression ships.
 *
 * Exact equality would fail on whitespace trivia, so this asserts the weaker but
 * sufficient property: every dynamic value the builder emits also appears in the
 * rendered template.
 *
 * Note the direction. A sample the builder does NOT emit is skipped, so this
 * proves the seed is no POORER than the builder — never that it is identical.
 * contract-expiry is deliberately richer since migration 73: its body carries
 * {{unit}}, {{days_until}} and {{company_name}} for the WhatsApp leg, and
 * contractExpiryTemplate emits none of the three. Those samples are silently
 * skipped here. contractExpiryJob.test.ts is what checks the sender fills them.
 */
const CASES = [
  {
    type: "receipt" as const,
    code: "receipt",
    build: (locale: "ar" | "en") =>
      paymentReceiptTemplate({
        locale,
        tenantName: "أحمد المطيري",
        amount: "250.000 KWD",
        paymentDate: "2026-08-01",
        reference: "PAY-2026-0042",
      }),
  },
  {
    type: "overdue_reminder" as const,
    code: "overdue-reminder",
    build: (locale: "ar" | "en") =>
      overdueReminderTemplate({
        locale,
        tenantName: "أحمد المطيري",
        outstanding: "500.000 KWD",
        daysOverdue: 12,
      }),
  },
  {
    type: "contract_expiry" as const,
    code: "contract-expiry",
    build: (locale: "ar" | "en") =>
      contractExpiryTemplate({
        locale,
        tenantName: "أحمد المطيري",
        contractCode: "CTR-2025-0130",
        endDate: "2026-12-31",
      }),
  },
  {
    type: "deposit_confirmation" as const,
    code: "deposit-confirmation",
    build: (locale: "ar" | "en") =>
      depositConfirmationTemplate({
        locale,
        amount: "1,000.000 KWD",
        bankName: "بنك الكويت الوطني",
        depositDate: "2026-08-01",
        code: "DEP-2026-0007",
        note: "إيداع نقدي",
      }),
  },
  {
    type: "payment_admin_alert" as const,
    code: "payment-admin-alert",
    build: (locale: "ar" | "en") =>
      paymentAdminAlertTemplate({
        locale,
        tenantName: "أحمد المطيري",
        amount: "250.000 KWD",
        periods: "2026-08",
        paymentCodes: "PAY-2026-0042",
        paymentMethod: "رابط دفع (كي نت)",
      }),
  },
];

describe("seeded bodies reproduce the builders", () => {
  for (const testCase of CASES) {
    for (const locale of ["ar", "en"] as const) {
      test(`${testCase.code}-${locale} keeps every dynamic value`, () => {
        const samples = sampleVariablesFor(testCase.type);
        const seeded = SEEDED_BODIES[testCase.code][locale];
        const rendered = renderTemplate(seeded, samples) ?? "";
        const builderHtml = testCase.build(locale).html;

        for (const value of Object.values(samples)) {
          if (!builderHtml.includes(value)) continue; // builder does not use it
          expect(rendered, `${testCase.code}-${locale} lost "${value}"`).toContain(value);
        }
      });
    }
  }

  test("payment-admin-alert hides the method line from a sender that never sets it", () => {
    // Migration 245 can land before the bundle that fills {{payment_method}};
    // the old sender's variables must render no line and no raw placeholder.
    const { payment_method: _omitted, ...oldSenderVars } =
      sampleVariablesFor("payment_admin_alert");
    for (const locale of ["ar", "en"] as const) {
      const rendered = renderTemplate(SEEDED_BODIES["payment-admin-alert"][locale], oldSenderVars);
      expect(rendered).not.toContain("payment_method");
      expect(rendered).not.toMatch(/طريقة الدفع|Payment method/);
    }
  });

  test("invoice-document keeps its line-item values", () => {
    const samples = sampleVariablesFor("document_send");
    const seeded = SEEDED_BODIES["invoice-document"].en;
    const rendered = renderTemplate(seeded, samples) ?? "";
    for (const key of ["invoice_number", "subtotal", "due_date", "unit_name"]) {
      expect(rendered).toContain(samples[key]);
    }
  });
});

/**
 * The logo substitution only works if the marker is in the ONE place every
 * template funnels through — `wrapLayout`, called from ten sites in
 * emailTemplates.ts. A template that grew its own header would silently never
 * carry a logo, and nothing else would notice. These fixtures already build
 * every registry template, so the check rides along with them.
 */
describe("every built-in template carries the logo marker", () => {
  for (const testCase of CASES) {
    for (const locale of ["ar", "en"] as const) {
      test(`${testCase.code}-${locale} emits the marker and substitutes cleanly`, () => {
        const html = testCase.build(locale).html;
        expect(html).toContain(EMAIL_LOGO_MARKER);

        const branded = applyEmailLogo(html, "https://example.test/logo.png", "Danat");
        expect(branded).toContain('src="https://example.test/logo.png"');
        expect(branded).not.toContain(EMAIL_LOGO_MARKER);

        const unbranded = applyEmailLogo(html, null, "Danat");
        expect(unbranded).not.toContain(EMAIL_LOGO_MARKER);
        expect(unbranded).not.toContain("<img");
      });
    }
  }
});
