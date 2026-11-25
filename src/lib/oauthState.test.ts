import { describe, expect, test } from "vitest";

import { createOAuthState, STATE_TTL_MS, verifyOAuthState } from "@/lib/oauthState";

const SECRET = "test-signing-secret";
const USER = "11111111-1111-1111-1111-111111111111";
const NOW = 1_800_000_000_000;

describe("OAuth state", () => {
  test("round-trips a freshly minted state", () => {
    const state = createOAuthState(USER, SECRET, NOW);
    const result = verifyOAuthState(state, SECRET, NOW + 1_000);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe(USER);
      expect(result.payload.expiresAt).toBe(NOW + STATE_TTL_MS);
    }
  });

  test("two states for the same user differ", () => {
    // The nonce is what stops a captured state from being reusable across
    // attempts even inside its TTL window.
    expect(createOAuthState(USER, SECRET, NOW)).not.toBe(createOAuthState(USER, SECRET, NOW));
  });

  test("rejects a state signed with a different secret", () => {
    // This is the forgery case: an attacker who can reach the callback but does
    // not hold the server secret.
    const forged = createOAuthState(USER, "attacker-secret", NOW);
    expect(verifyOAuthState(forged, SECRET, NOW)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  test("rejects a tampered payload", () => {
    const state = createOAuthState(USER, SECRET, NOW);
    const [encoded, signature] = state.split(".");
    const swapped = Buffer.from(
      JSON.stringify({
        nonce: "n",
        expiresAt: NOW + STATE_TTL_MS,
        userId: "22222222-2222-2222-2222-222222222222",
      }),
      "utf8",
    ).toString("base64url");

    expect(encoded).not.toBe(swapped);
    expect(verifyOAuthState(`${swapped}.${signature}`, SECRET, NOW)).toEqual({
      valid: false,
      reason: "bad-signature",
    });
  });

  test("rejects an expired state", () => {
    const state = createOAuthState(USER, SECRET, NOW);
    expect(verifyOAuthState(state, SECRET, NOW + STATE_TTL_MS + 1)).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  test("accepts right up to the expiry boundary", () => {
    const state = createOAuthState(USER, SECRET, NOW);
    expect(verifyOAuthState(state, SECRET, NOW + STATE_TTL_MS - 1).valid).toBe(true);
    expect(verifyOAuthState(state, SECRET, NOW + STATE_TTL_MS).valid).toBe(false);
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of [null, undefined, "", "no-separator", ".", "abc.", ".abc"]) {
      expect(verifyOAuthState(bad, SECRET, NOW).valid).toBe(false);
    }
  });

  test("rejects a correctly signed payload that is not a state", () => {
    // Signature valid, contents nonsense — verification must look at both.
    const encoded = Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url");
    const state = `${encoded}.${createOAuthState(USER, SECRET, NOW).split(".")[1]}`;
    expect(verifyOAuthState(state, SECRET, NOW).valid).toBe(false);
  });
});
