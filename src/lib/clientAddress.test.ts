import { describe, expect, test } from "vitest";

import { clientAddress } from "@/lib/clientAddress";

/**
 * يبني طلباً يحمل الترويسات المعطاة فقط، دون غيرها.
 *
 * Each case names the exact headers it cares about, so a header this helper
 * added on its own could make a forged value look trusted.
 */
function requestWith(headers: Record<string, string>): Request {
  return new Request("https://danat-future.test/fns/submitContactInquiry", { headers });
}

describe("clientAddress", () => {
  test("prefers cf-connecting-ip even when x-forwarded-for is present and different", () => {
    // The whole point of the H6 fix. x-forwarded-for's first element is
    // whatever the client sent — Cloudflare and Traefik append to that header,
    // they do not replace it — so trusting it made the old limiter's key
    // forgeable. Only cf-connecting-ip is the address the edge itself observed.
    const request = requestWith({
      "cf-connecting-ip": "198.51.100.7",
      "x-forwarded-for": "10.0.0.1, 203.0.113.9",
    });

    expect(clientAddress(request)).toBe("198.51.100.7");
  });

  test("falls back to the first x-forwarded-for element when cf-connecting-ip is absent", () => {
    const request = requestWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(clientAddress(request)).toBe("203.0.113.9");
  });

  test("trims the address it keeps", () => {
    const request = requestWith({ "cf-connecting-ip": " 198.51.100.7 " });

    expect(clientAddress(request)).toBe("198.51.100.7");
  });

  test("returns null when neither header carries an address", () => {
    // The public endpoints then fall back to one shared "unknown" bucket —
    // the limit still applies, it just stops distinguishing callers, which is
    // why a null here must never skip the limiter.
    expect(clientAddress(requestWith({}))).toBe(null);
    expect(clientAddress(requestWith({ "cf-connecting-ip": "  ", "x-forwarded-for": " ," }))).toBe(
      null,
    );
  });
});
