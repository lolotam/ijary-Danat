import { describe, expect, test } from "vitest";

import {
  configValue,
  draftToConfig,
  providerFieldKeys,
  storedConfig,
} from "@/lib/providers/providerFields";

describe("providerFieldKeys", () => {
  test("lists SMTP's four required keys, required first", () => {
    const keys = providerFieldKeys("smtp");
    expect(keys.map((field) => field.key)).toEqual([
      "host_env",
      "port_env",
      "user_env",
      "secret_env",
    ]);
    expect(keys.every((field) => field.required)).toBe(true);
  });

  test("puts optional keys after required ones", () => {
    // whatsapp_cloud_api is the provider that has both, so it is the only one
    // that can prove the ordering.
    const keys = providerFieldKeys("whatsapp_cloud_api");
    const firstOptional = keys.findIndex((field) => !field.required);
    expect(firstOptional).toBeGreaterThan(0);
    expect(keys.slice(firstOptional).every((field) => !field.required)).toBe(true);
  });

  test("carries the documented env-var name as the placeholder", () => {
    const secret = providerFieldKeys("resend").find((field) => field.key === "secret_env");
    expect(secret?.placeholder).toBe("RESEND_API_KEY");
  });
});

describe("draftToConfig", () => {
  test.each(["", "   ", "	"])(
    "a box holding %j is dropped rather than written as an empty string",
    (blank) => {
      // The database constraint rejects a blank where it expects an env-var
      // name, so sending "" surfaces as a constraint violation instead of the
      // key simply being unset.
      expect(draftToConfig({ secret_env: "RESEND_API_KEY", waba_id_env: blank })).toEqual({
        secret_env: "RESEND_API_KEY",
      });
    },
  );

  test("keeps __proto__ as an ordinary data key", () => {
    expect(Object.hasOwn(draftToConfig({ ["__proto__"]: "WA_NAMESPACE" }), "__proto__")).toBe(true);
  });

  test("trims surrounding whitespace off a real value", () => {
    expect(draftToConfig({ secret_env: "  RESEND_API_KEY  " })).toEqual({
      secret_env: "RESEND_API_KEY",
    });
  });
});

describe("configValue", () => {
  test("reads a stored string", () => {
    expect(configValue({ secret_env: "RESEND_API_KEY" }, "secret_env")).toBe("RESEND_API_KEY");
  });

  test("renders a missing key as an empty box, not 'undefined'", () => {
    expect(configValue({ secret_env: "X" }, "host_env")).toBe("");
  });

  // Wrapped rows: `test.each` spreads an array row into arguments, so a bare
  // ["an","array"] row would pass "an" and never exercise the Array.isArray branch.
  test.each([[null], ["a string"], [42], [["an", "array"]]])(
    "%j config yields an empty box",
    (config) => {
      expect(configValue(config as never, "secret_env")).toBe("");
    },
  );

  test("stringifies a non-string value rather than showing nothing", () => {
    // `graph_api_version` is documented as "v23.0" but a stored number would
    // otherwise vanish from the form and be silently dropped on the next save.
    expect(configValue({ port_env: 587 } as never, "port_env")).toBe("587");
  });
});

describe("storedConfig", () => {
  test("keeps a key the form does not render", () => {
    // The save path merges over this. Without it, a key the screen cannot show —
    // migration 07 seeds `template_namespace_ref` — is a key it silently
    // deletes the first time an admin presses Save.
    expect(
      storedConfig({ secret_env: "RESEND_API_KEY", template_namespace_ref: "WA_NAMESPACE" }),
    ).toEqual({ secret_env: "RESEND_API_KEY", template_namespace_ref: "WA_NAMESPACE" });
  });

  test("carries a nested value through instead of stringifying it", () => {
    // `config` is unrestricted jsonb. String() would store "[object Object]"
    // and "a,b" — corrupting on save the very keys this merge preserves.
    expect(storedConfig({ nested: { a: 1 }, list: ["a", "b"], secret_env: "X" } as never)).toEqual({
      nested: { a: 1 },
      list: ["a", "b"],
      secret_env: "X",
    });
  });

  test("keeps __proto__ as an ordinary data key", () => {
    // `stored["__proto__"] = v` on a plain object sets the prototype instead of
    // creating an own property, so the key would vanish on the next save.
    const parsed = JSON.parse('{"__proto__": "WA_NAMESPACE", "secret_env": "X"}') as never;
    expect(Object.hasOwn(storedConfig(parsed), "__proto__")).toBe(true);
  });

  test("drops a null value rather than carrying the string 'null' forward", () => {
    expect(storedConfig({ secret_env: "X", waba_id_env: null } as never)).toEqual({
      secret_env: "X",
    });
  });

  test.each([[null], ["a string"], [42], [["an", "array"]]])(
    "%j is not an object and yields nothing to merge",
    (config) => {
      expect(storedConfig(config as never)).toEqual({});
    },
  );
});
