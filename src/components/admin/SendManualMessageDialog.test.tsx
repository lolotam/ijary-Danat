import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPreviewPayload, previewEnabled } from "@/components/admin/MessagePreviewPanel";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/SendManualMessageDialog.tsx"),
  "utf8",
);

describe("SendManualMessageDialog", () => {
  it("shows the manual fields only for free text or an explicit one-off edit", () => {
    // Before this the boxes rendered for every non-company_info selection and sat
    // empty under a template, so typing in them silently replaced the template
    // with nothing on screen saying so.
    expect(SOURCE).toMatch(/showManualFields\s*=\s*isFreeText\s*\|\|\s*templateEditMode/);
  });

  it("pins the locale when a one-off edit starts", () => {
    // subject/body are single fields in the payload but a template carries both
    // subject_ar/body_ar and subject_en/body_en. On "auto" an Arabic edit would
    // also be sent as the English body.
    expect(SOURCE).toMatch(/setManualLocale\(effectiveManualLocale\)/);
  });

  it("cancels an in-progress edit when the tenant changes", () => {
    // effectiveManualLocale falls back to the tenant's preferred_language, so a
    // pin taken for one tenant would hold Arabic text against an English reader.
    const tenantHandler = SOURCE.slice(SOURCE.indexOf("setManualTenant(value)"));

    expect(tenantHandler.slice(0, 200)).toContain("cancelTemplateEdit()");
  });

  it("cancels an in-progress edit when the template changes", () => {
    const templateHandler = SOURCE.slice(SOURCE.indexOf("setManualTemplate(value)"));

    expect(templateHandler.slice(0, 300)).toContain("cancelTemplateEdit()");
  });

  it("no longer advertises placeholders that nothing resolves", () => {
    // The hint named {{months_until_expiry}}, removed as a defect by migration
    // 58, and {{period}}, which no manual-send type resolves. Both reached
    // tenants as literal braces.
    expect(SOURCE).not.toMatch(/notifications\.placeholders/);
  });
});

describe("unresolved template variables block the send (audit M10)", () => {
  it("listens to the preview for unresolved variables", () => {
    expect(SOURCE).toContain("onUnresolvedChange={setUnresolvedVariables}");
  });

  it("disables Send while the shown preview reports any", () => {
    // Gated on showPreview so a stale report from a preview no longer on
    // screen cannot block a send the operator can see nothing wrong with.
    expect(SOURCE).toMatch(
      /\(showPreview && \(unresolvedVariables === null \|\| unresolvedVariables\.length > 0\)\)/,
    );
  });
});

describe("previewEnabled", () => {
  it("previews free text once a body exists", () => {
    // Free text has no template code but does have a body, and buildFinalMessage
    // resolves that fine. Requiring a code left the admin looking at their own
    // {{braces}} with no way to check what would actually be sent.
    expect(previewEnabled({ tenantId: "t1", templateCode: null, body: "{{outstanding}}" })).toBe(
      true,
    );
  });

  it("stays empty for free text with nothing written yet", () => {
    expect(previewEnabled({ tenantId: "t1", templateCode: null, body: "   " })).toBe(false);
    expect(previewEnabled({ tenantId: "t1", templateCode: null, body: undefined })).toBe(false);
  });

  it("still previews a template with no body override", () => {
    expect(previewEnabled({ tenantId: "t1", templateCode: "overdue-ar", body: null })).toBe(true);
  });

  it("needs a tenant either way", () => {
    expect(previewEnabled({ tenantId: "", templateCode: "overdue-ar", body: "x" })).toBe(false);
  });
});

describe("buildPreviewPayload", () => {
  const editing = {
    tenantId: "t1",
    templateCode: "overdue-ar",
    contractId: null,
    channel: "email" as const,
    subject: "موضوع معدّل",
    body: "نص معدّل",
    overrideLocale: "ar" as const,
  };

  it("applies a one-off edit to the edited locale only", () => {
    // The panel renders ar and en from one pair of override fields. Handing the
    // Arabic edit to both tabs previewed a message that would never be sent.
    expect(buildPreviewPayload(editing, "ar").body).toBe("نص معدّل");
    expect(buildPreviewPayload(editing, "en").body).toBeNull();
    expect(buildPreviewPayload(editing, "en").subject).toBeNull();
  });

  it("applies free-text overrides to both locales when no locale is pinned", () => {
    // Free text is not a translation of anything — the admin wrote one message
    // and both preview tabs should render it.
    const freeText = { ...editing, templateCode: null, overrideLocale: undefined };

    expect(buildPreviewPayload(freeText, "ar").body).toBe("نص معدّل");
    expect(buildPreviewPayload(freeText, "en").body).toBe("نص معدّل");
  });
});
