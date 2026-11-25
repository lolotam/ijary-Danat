import { describe, expect, test } from "vitest";

import { toChatNumber } from "./whatsappLink";

describe("toChatNumber", () => {
  test("adds the Kuwait country code to a bare local mobile", () => {
    expect(toChatNumber("51234567")).toBe("96551234567");
  });

  test("keeps a number that already carries its country code", () => {
    expect(toChatNumber("+965 5123 4567")).toBe("96551234567");
    expect(toChatNumber("96551234567")).toBe("96551234567");
  });

  test("normalises formatting so one tenant maps to one thread", () => {
    // The tenant record and the chat row must agree, or the link opens an empty
    // second thread beside the real one.
    expect(toChatNumber("+965-5123-4567")).toBe(toChatNumber("96551234567"));
  });

  test("rejects a number the gateway could not dial", () => {
    expect(toChatNumber(null)).toBe(null);
    expect(toChatNumber("")).toBe(null);
    expect(toChatNumber("   ")).toBe(null);
    expect(toChatNumber("22334455")).toBe(null); // landline, not a WhatsApp mobile
    expect(toChatNumber("12345")).toBe(null);
  });

  test("accepts a non-Kuwait number written in international form", () => {
    expect(toChatNumber("+20 100 123 4567")).toBe("201001234567");
  });
});
