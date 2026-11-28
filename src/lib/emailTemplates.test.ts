import { describe, expect, test } from "vitest";

import {
  applyEmailBrandName,
  EMAIL_BRAND_NAME_CLOSE,
  EMAIL_BRAND_NAME_OPEN,
  invoiceDocumentTemplate,
  renderEmailDocument,
  tenantCredentialsTemplate,
  welcomeManagerialTemplate,
} from "@/lib/emailTemplates";

/**
 * T11 requires every created account — admin, managerial or tenant — to receive
 * an email that states its sign-in email, username and password. These templates
 * are the only place that text is produced, and they have no other coverage.
 */
const BASE = {
  username: "aya.k",
  password: "Str0ng&Pass<x>",
  email: "aya@example.com",
} as const;

/** The full five-field set the credentials box now shows. */
const FULL = {
  ...BASE,
  displayName: "آية الكندري",
  mobile: "+965 5000 1234",
} as const;

describe("credential email templates", () => {
  describe.each(["en", "ar"] as const)("tenantCredentialsTemplate (%s)", (locale) => {
    const tpl = tenantCredentialsTemplate({
      locale,
      tenantName: "شركة الخليج",
      portalUrl: "https://danat-future.com/portal",
      fields: BASE,
    });

    test("html states the email, username and password", () => {
      expect(tpl.html).toContain(BASE.email);
      expect(tpl.html).toContain(BASE.username);
      // The password contains &, < and > — assert on the escaped form, since
      // the raw string must never reach the markup.
      expect(tpl.html).toContain("Str0ng&amp;Pass&lt;x&gt;");
      expect(tpl.html).not.toContain(BASE.password);
    });

    test("plain-text part states all three unescaped", () => {
      expect(tpl.text).toContain(BASE.email);
      expect(tpl.text).toContain(BASE.username);
      expect(tpl.text).toContain(BASE.password);
    });

    test("the built-in intro names the sending company, not a fixed one", () => {
      expect(tpl.html).not.toContain("دانة");
      expect(tpl.html).not.toContain("Danat");
      const named = applyEmailBrandName(tpl.html, "شركة النخبة");
      // Header and intro both carry the sending company once substituted.
      expect(named.split("شركة النخبة").length - 1).toBe(2);
    });

    test("credential values are marked LTR so they survive an RTL layout", () => {
      expect(tpl.html).toContain(`<span dir="ltr">${BASE.username}</span>`);
    });
  });

  test("labels follow the locale", () => {
    const en = tenantCredentialsTemplate({
      locale: "en",
      tenantName: "Gulf Co",
      portalUrl: "u",
      fields: BASE,
    });
    const ar = tenantCredentialsTemplate({
      locale: "ar",
      tenantName: "شركة الخليج",
      portalUrl: "u",
      fields: BASE,
    });
    expect(en.html).toContain("Password");
    expect(ar.html).toContain("كلمة المرور");
    expect(ar.html).not.toContain("<strong>Password:</strong>");
  });

  test("the English greeting uses a latin comma, not an Arabic one", () => {
    const en = tenantCredentialsTemplate({
      locale: "en",
      tenantName: "Gulf Co",
      portalUrl: "u",
      fields: BASE,
    });
    expect(en.html).toContain("Hello Gulf Co,");
    expect(en.html).not.toContain("،");
  });

  test("omitting the email renders no empty label row", () => {
    const tpl = tenantCredentialsTemplate({
      locale: "en",
      tenantName: "Gulf Co",
      portalUrl: "u",
      fields: { username: BASE.username, password: BASE.password },
    });
    expect(tpl.html).not.toContain("<strong>Email:</strong>");
    expect(tpl.text).not.toContain("Email:");
    expect(tpl.html).toContain(BASE.username);
  });

  test("welcomeManagerialTemplate states all three in html and text", () => {
    const tpl = welcomeManagerialTemplate({
      locale: "en",
      displayName: "Waleed",
      loginUrl: "https://danat-future.com/admin",
      fields: BASE,
    });
    expect(tpl.html).toContain(BASE.email);
    expect(tpl.html).toContain(BASE.username);
    expect(tpl.text).toContain(BASE.email);
    expect(tpl.text).toContain(BASE.password);
  });

  describe("the five-field credentials box", () => {
    test.each(["en", "ar"] as const)("shows name and WhatsApp too (%s)", (locale) => {
      const tpl = tenantCredentialsTemplate({
        locale,
        tenantName: "شركة الخليج",
        portalUrl: "u",
        fields: FULL,
      });
      for (const value of [FULL.displayName, FULL.username, FULL.email, FULL.mobile]) {
        expect(tpl.html).toContain(value);
        expect(tpl.text).toContain(value);
      }
      expect(tpl.html).toContain("Str0ng&amp;Pass&lt;x&gt;");
    });

    test("the mobile row is dropped when there is no number", () => {
      const tpl = welcomeManagerialTemplate({
        locale: "en",
        displayName: "Waleed",
        loginUrl: "u",
        fields: { ...FULL, mobile: null },
      });
      expect(tpl.html).not.toContain("<strong>WhatsApp:</strong>");
      expect(tpl.text).not.toContain("WhatsApp:");
    });

    test("a whitespace-only value is treated as absent, not printed blank", () => {
      const tpl = welcomeManagerialTemplate({
        locale: "en",
        displayName: "Waleed",
        loginUrl: "u",
        fields: { ...FULL, mobile: "   " },
      });
      expect(tpl.html).not.toContain("<strong>WhatsApp:</strong>");
    });

    test("fields keep the order name, username, password, email, WhatsApp", () => {
      const tpl = welcomeManagerialTemplate({
        locale: "en",
        displayName: "Waleed",
        loginUrl: "u",
        fields: FULL,
      });
      const order = ["Name", "Username", "Password", "Email", "WhatsApp"].map((label) =>
        tpl.html.indexOf(`<strong>${label}:</strong>`),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every((index) => index >= 0)).toBe(true);
    });
  });

  describe("the editable intro from notification_templates", () => {
    test("replaces the built-in opening but keeps the box and the button", () => {
      const tpl = tenantCredentialsTemplate({
        locale: "en",
        tenantName: "Gulf Co",
        portalUrl: "https://danat-future.com/portal",
        intro: "<p>Bespoke welcome copy.</p>",
        subject: "Bespoke subject",
        fields: FULL,
      });
      expect(tpl.html).toContain("Bespoke welcome copy.");
      expect(tpl.html).not.toContain("An account has been created for you");
      expect(tpl.subject).toBe("Bespoke subject");
      // The layout stays under code's control.
      expect(tpl.html).toContain(FULL.mobile);
      expect(tpl.html).toContain("Open portal");
    });

    test("falls back to the built-in copy when the template is missing or blank", () => {
      const tpl = tenantCredentialsTemplate({
        locale: "en",
        tenantName: "Gulf Co",
        portalUrl: "u",
        intro: "   ",
        subject: null,
        fields: BASE,
      });
      expect(tpl.html).toContain("An account has been created for you");
      expect(tpl.subject).toBe("Your tenant portal credentials — Gulf Co");
    });
  });
});

describe("renderEmailDocument", () => {
  test("wraps inner content in the branded shell", () => {
    const html = renderEmailDocument("en", "Receipt", "<p>Hello</p>");
    expect(html).toContain("<p>Hello</p>");
    expect(html).toContain('dir="ltr"');
  });

  test("the header carries the platform name until the send path names the company", () => {
    const html = renderEmailDocument("en", "Receipt", "<p>Hello</p>");
    expect(html).toContain(`${EMAIL_BRAND_NAME_OPEN}IJARY${EMAIL_BRAND_NAME_CLOSE}`);
    expect(html).not.toContain("Danat");

    const named = applyEmailBrandName(html, "Gulf <Estates>");
    expect(named).toContain("Gulf &lt;Estates&gt;");
    expect(named).not.toContain(">IJARY<");
    // Substituting again replaces the name instead of nesting a second one.
    expect(applyEmailBrandName(named, "Renamed Co")).toContain(
      `${EMAIL_BRAND_NAME_OPEN}Renamed Co${EMAIL_BRAND_NAME_CLOSE}`,
    );
    expect(applyEmailBrandName(named, "Renamed Co")).not.toContain("Gulf");
  });

  test("a blank or missing company name keeps the platform default", () => {
    const html = renderEmailDocument("ar", "إيصال", "<p>مرحبا</p>");
    expect(applyEmailBrandName(html, "  ")).toBe(html);
    expect(applyEmailBrandName(html, undefined)).toBe(html);
  });

  test("shell is fluid on narrow screens (no fixed 600px width only)", () => {
    const html = renderEmailDocument("en", "Receipt", "<p>Hello</p>");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain("width:100%");
    // Fixed-only width tables overflow on phones.
    expect(html).not.toMatch(/width="600"/);
  });

  test("an Arabic shell is RTL", () => {
    expect(renderEmailDocument("ar", "إيصال", "<p>مرحبا</p>")).toContain('dir="rtl"');
  });

  test("a full document is used verbatim, shell skipped", () => {
    // The escape hatch: an admin who pastes a whole document gets exactly that,
    // brand header included or not, as they chose.
    const doc = "<!doctype html><html><body>mine</body></html>";
    expect(renderEmailDocument("en", "T", doc)).toBe(doc);
  });

  test("detection ignores leading whitespace and case", () => {
    const doc = "\n  <HTML><body>mine</body></HTML>";
    expect(renderEmailDocument("en", "T", doc)).toBe(doc);
  });

  test("a body merely containing <html> later is still wrapped", () => {
    // Only a body that STARTS as a document opts out. A paragraph mentioning
    // <html> in prose must not accidentally lose the brand shell.
    const body = "<p>use &lt;html&gt; carefully</p>";
    expect(renderEmailDocument("en", "T", body)).toContain(EMAIL_BRAND_NAME_OPEN);
  });
});

describe("invoiceDocumentTemplate discount rows", () => {
  const base = {
    locale: "en" as const,
    tenantName: "T",
    unitName: "U",
    propertyName: "P",
    invoiceNumber: "INV-1",
    period: "8/2026",
    issueDate: "2026-08-01",
    dueDate: "2026-08-01",
    subtotal: "500 KWD",
    paid: "0 KWD",
    total: "500 KWD",
  };
  test("omits Subtotal and Discount when discount is null", () => {
    const html = invoiceDocumentTemplate({ ...base, discount: null }).html;
    expect(html).not.toContain(">Discount<");
    expect(html).not.toContain(">Subtotal<");
    expect(html).toContain(">Total due<");
  });
  test("keeps both rows when a discount exists", () => {
    const html = invoiceDocumentTemplate({ ...base, discount: "50 KWD" }).html;
    expect(html).toContain(">Discount<");
    expect(html).toContain(">Subtotal<");
  });
});
