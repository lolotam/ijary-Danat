import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FinalMessage } from "@/fns/resolveTemplateVariables";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    dir: "ltr",
    setLocale: () => undefined,
    toggle: () => undefined,
  }),
  useOptionalI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    dir: "ltr" as const,
  }),
}));

const { MessagePreviewView } = await import("./MessagePreviewPanel");

const sample: FinalMessage = {
  variables: {
    tenant_name: "Ahmed",
    company_name: "Danat",
    outstanding: "250.000 KWD",
    days_overdue: "12",
  },
  subject: "Overdue 250.000 KWD",
  bodyHtml: "<p>Balance <strong>250.000 KWD</strong></p>",
  bodyText: "Balance 250.000 KWD",
  missing: ["period"],
  templateCode: "overdue-reminder-en",
  templateType: "overdue_reminder",
  locale: "en",
  unavailableReason: null,
};

/**
 * يبني وسم HTML للمعاينة مع بيانات محلولة جاهزة (بدون شبكة).
 */
function renderView(props: Partial<Parameters<typeof MessagePreviewView>[0]> = {}) {
  return renderToStaticMarkup(
    <MessagePreviewView ar={sample} en={sample} loading={false} error={null} {...props} />,
  );
}

describe("MessagePreviewView", () => {
  it("renders the resolved subject and body", () => {
    const markup = renderView();
    expect(markup).toContain("Overdue 250.000 KWD");
    expect(markup).toContain("250.000 KWD");
  });

  it("lists unresolved placeholders so the admin sees them before sending", () => {
    const markup = renderView();
    expect(markup).toContain("notifications.previewMissing");
    expect(markup).toContain("{{period}}");
  });

  it("shows both Arabic and English previews", () => {
    // Radix Select portals its items; assert the switch exists in source.
    // Both locales are resolved server-side (ar + en queries) and passed in.
    const source = readFileSync(
      join(process.cwd(), "src/components/admin/MessagePreviewPanel.tsx"),
      "utf8",
    );
    expect(source).toContain('SelectItem value="ar"');
    expect(source).toContain('SelectItem value="en"');
    // Each locale is requested independently via payloadFor("ar"|"en").
    expect(source).toContain('payloadFor("ar")');
    expect(source).toContain('payloadFor("en")');
  });

  it("renders HTML inside a sandboxed iframe, not into the admin's own DOM", () => {
    const markup = renderView();
    expect(markup).toMatch(/<iframe[^>]*sandbox=""/);
    expect(markup).toContain("srcDoc=");
  });

  it("shows the empty state when no template is chosen", () => {
    const markup = renderView({ empty: true, ar: null, en: null });
    expect(markup).toContain("notifications.previewEmpty");
  });

  /**
   * `unavailableReason` is a CONTRACT between buildFinalMessage and its three
   * consumers, not a property of the builder. Testing only that the builder sets
   * it proves nothing about whether anyone acts on it — this panel could drop it
   * and render an empty body while the builder tests stayed green.
   *
   * The locale-counterpart path that used to set it is gone with the collapse,
   * but the missing/inactive path remains and must still surface here.
   */
  it("warns instead of rendering an empty message when the template is unavailable", () => {
    const unavailable = { ...sample, unavailableReason: "No active template for receipt." };
    const markup = renderView({ ar: unavailable, en: unavailable });

    expect(markup).toContain("notifications.previewLocaleUnavailable");
    expect(markup).toContain("No active template for receipt.");
    // The body pane must not render alongside the warning; an admin seeing both
    // cannot tell which one describes what will actually be sent.
    expect(markup).not.toContain("srcDoc");
  });
});

describe("MessagePreviewPanel source contract", () => {
  it("wires resolveTemplateVariables and uses a sandboxed iframe for HTML", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/admin/MessagePreviewPanel.tsx"),
      "utf8",
    );
    expect(source).toContain("resolveTemplateVariables");
    expect(source).toContain('sandbox=""');
    expect(source).toContain("srcDoc");
    // No runtime DOM injection of template HTML into the admin document.
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});
