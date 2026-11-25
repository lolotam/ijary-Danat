import { describe, expect, it } from "vitest";

import { validateProviderConfig } from "./configValidation";
import { draftToConfig, providerFieldKeys } from "@/lib/providers/providerFields";

describe("validateProviderConfig", () => {
  it("accepts a config made only of environment-variable references", () => {
    expect(validateProviderConfig("resend", '{"secret_env":"RESEND_API_KEY"}')).toBeNull();
  });

  it("accepts the Cloud API config including the optional Graph version", () => {
    const config = JSON.stringify({
      secret_env: "WHATSAPP_ACCESS_TOKEN",
      phone_number_id_env: "WHATSAPP_PHONE_NUMBER_ID",
      waba_id_env: "WHATSAPP_WABA_ID",
      graph_api_version: "v23.0",
    });
    expect(validateProviderConfig("whatsapp_cloud_api", config)).toBeNull();
  });

  it("reports the JSON parse problem rather than a generic failure", () => {
    expect(validateProviderConfig("resend", "{oops}")).toMatch(/Not valid JSON/);
  });

  it.each([
    {
      scenario: "a non-object config",
      provider: "resend" as const,
      raw: "[]",
      expected: /must be a JSON object/,
    },
    {
      scenario: "a raw credential under a secret-looking key",
      provider: "resend" as const,
      raw: '{"api_key":"re_live_abc"}',
      expected: /looks like a raw credential/,
    },
    {
      scenario: "a reference key holding the value instead of the variable name",
      provider: "resend" as const,
      raw: '{"secret_env":"re_live_abc"}',
      expected: /UPPER_SNAKE_CASE/,
    },
    {
      scenario: "a non-string value",
      provider: "resend" as const,
      raw: '{"secret_env":123}',
      expected: /must be a string/,
    },
    {
      scenario: "a config missing required keys",
      provider: "twilio" as const,
      raw: '{"secret_env":"TWILIO_AUTH_TOKEN"}',
      expected: /account_sid_env.*from_whatsapp_env/,
    },
  ])("rejects $scenario with a message naming the problem", ({ provider, raw, expected }) => {
    expect(validateProviderConfig(provider, raw)).toMatch(expected);
  });
});

describe("the provider form and the validator agree", () => {
  it.each(["smtp", "resend", "whatsapp_cloud_api", "twilio", "postora"] as const)(
    "%s: filling every field with its documented placeholder validates",
    (provider) => {
      // The form builds its fields from PROVIDER_CONFIG_SHAPE and the validator
      // reads the same map. This is what stops them drifting: a key added to one
      // and not honoured by the other fails here rather than at save time.
      const draft = Object.fromEntries(
        providerFieldKeys(provider).map((field) => [field.key, field.placeholder]),
      );
      expect(validateProviderConfig(provider, JSON.stringify(draftToConfig(draft)))).toBeNull();
    },
  );

  it("offers references, never a place to paste a credential", () => {
    const secret = providerFieldKeys("resend").find((field) => field.key === "secret_env");
    expect(secret?.placeholder).toContain("RESEND_API");
  });
});
