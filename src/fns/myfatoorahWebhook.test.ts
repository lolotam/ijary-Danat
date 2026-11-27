import { describe, expect, it } from "vitest";

import { normalizeMethod } from "./myfatoorahWebhook";

describe("myfatoorahWebhook compat exports", () => {
  it.each([
    { input: "KNET", expected: "knet" },
    { input: "Apple Pay", expected: "applepay" },
    { input: "GOOGLE_PAY", expected: "googlepay" },
    { input: "VISA/MASTER", expected: "card" },
    { input: null, expected: null },
  ])("normalizes $input to $expected", ({ input, expected }) => {
    expect(normalizeMethod(input)).toBe(expected);
  });
});
