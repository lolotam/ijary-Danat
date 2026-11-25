import { describe, expect, it } from "vitest";

import type { ProviderTemplateMapping } from "./whatsappTemplateBinding";
import {
  allowsFreeform,
  isMappedIdentifier,
  resolveMetaBinding,
  resolveTwilioBinding,
} from "./whatsappTemplateBinding";

const mapping: ProviderTemplateMapping = {
  allow_freeform: false,
  provider_language_code: null,
  provider_param_keys: ["tenant_name", "amount"],
  provider_template_name: "danat_receipt_ar",
  twilio_content_sid: "HXabc",
  twilio_variable_keys: ["tenant_name", "amount"],
};

const payload = { amount: "150.000 KWD", periods: "7/2026", tenant_name: "أحمد" };

describe("isMappedIdentifier", () => {
  it("accepts a recorded identifier", () => {
    expect(isMappedIdentifier("danat_receipt_ar")).toBe(true);
  });

  it("rejects the documentation placeholders so they can never be sent", () => {
    expect(isMappedIdentifier("META_TEMPLATE_NAME_REQUIRED")).toBe(false);
    expect(isMappedIdentifier("TWILIO_CONTENT_SID_REQUIRED")).toBe(false);
  });

  it("rejects absent and blank values", () => {
    expect(isMappedIdentifier(null)).toBe(false);
    expect(isMappedIdentifier("   ")).toBe(false);
  });
});

describe("resolveMetaBinding", () => {
  it("binds the approved name and ordered parameters", () => {
    const result = resolveMetaBinding(mapping, payload, "ar");

    expect(result).toEqual({
      ok: true,
      value: {
        languageCode: "ar",
        params: ["أحمد", "150.000 KWD"],
        templateName: "danat_receipt_ar",
      },
    });
  });

  it("falls back to the notification locale when no provider language is recorded", () => {
    const result = resolveMetaBinding(mapping, payload, "en");
    expect(result.ok && result.value.languageCode).toBe("en");
  });

  it("prefers the recorded provider language code when Meta approved a variant", () => {
    const result = resolveMetaBinding(
      { ...mapping, provider_language_code: "ar_AE" },
      payload,
      "ar",
    );
    expect(result.ok && result.value.languageCode).toBe("ar_AE");
  });

  it("refuses when no approved template name is recorded", () => {
    const result = resolveMetaBinding({ ...mapping, provider_template_name: null }, payload, "ar");
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/No approved Meta template name/),
    });
  });

  it("refuses a placeholder name left over from setup", () => {
    const result = resolveMetaBinding(
      { ...mapping, provider_template_name: "META_TEMPLATE_NAME_REQUIRED" },
      payload,
      "ar",
    );
    expect(result.ok).toBe(false);
  });

  it("names every payload variable the template needs but does not have", () => {
    const result = resolveMetaBinding(mapping, { tenant_name: "أحمد" }, "ar");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("amount") });
  });

  it("refuses when the notification has no linked template at all", () => {
    expect(resolveMetaBinding(null, payload, "ar").ok).toBe(false);
  });

  it("stringifies numeric payload values so counts can be parameters", () => {
    const result = resolveMetaBinding(
      { ...mapping, provider_param_keys: ["months_until"] },
      { months_until: 4 },
      "ar",
    );
    expect(result.ok && result.value.params).toEqual(["4"]);
  });
});

describe("resolveTwilioBinding", () => {
  it("binds the Content SID and positional content variables", () => {
    const result = resolveTwilioBinding(mapping, payload);

    expect(result).toEqual({
      ok: true,
      value: { contentSid: "HXabc", contentVariables: { "1": "أحمد", "2": "150.000 KWD" } },
    });
  });

  it("refuses when no approved Content SID is recorded", () => {
    const result = resolveTwilioBinding({ ...mapping, twilio_content_sid: null }, payload);
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/No approved Twilio Content SID/),
    });
  });

  it("names the missing content variables", () => {
    const result = resolveTwilioBinding(mapping, { tenant_name: "أحمد" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("amount") });
  });
});

describe("allowsFreeform", () => {
  it("is false by default — an open service window is never assumed", () => {
    expect(allowsFreeform(mapping, payload)).toBe(false);
    expect(allowsFreeform(null, payload)).toBe(false);
  });

  it("is true when the template opts in", () => {
    expect(allowsFreeform({ ...mapping, allow_freeform: true }, payload)).toBe(true);
  });

  it("is true when the caller asserts an open service window on the payload", () => {
    expect(allowsFreeform(mapping, { whatsapp_freeform: true })).toBe(true);
  });
});
