import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring `state` values for the Gmail OAuth redirect.
 *
 * The OAuth `state` parameter is the only thing standing between the callback
 * and a cross-site request forgery: without it, an attacker can send an admin's
 * browser to our callback carrying *their* authorization code and silently
 * connect an attacker-controlled mailbox to this deployment.
 *
 * Rather than store nonces server-side (which would need a table and a sweep),
 * the state carries its own proof: a payload plus an HMAC over that payload,
 * keyed on a server-only secret. A forged or tampered state fails verification,
 * and an old one fails on expiry. Nothing about it is secret — it is not a
 * credential, it is an integrity check — so it is safe to hand to Google and
 * receive back through the browser.
 *
 * Server-only: `node:crypto` and the signing secret must never reach the bundle.
 */

/** How long a consent round-trip may take before its state is refused. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  /** Random per-attempt value; makes two states for the same user differ. */
  nonce: string;
  /** Epoch ms after which this state is refused. */
  expiresAt: number;
  /** Who started the flow, so the callback can attribute the connection. */
  userId: string;
  /** الشركة التي بدأ منها الربط حتى تُحفظ بيانات Gmail ضمن نطاقها عند العودة. */
  companyId?: string;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/** Builds a signed state for a consent redirect. */
export function createOAuthState(
  userId: string,
  secret: string,
  now: number = Date.now(),
  companyId?: string,
): string {
  const payload: OAuthStatePayload = {
    nonce: randomUUID(),
    expiresAt: now + STATE_TTL_MS,
    userId,
    ...(companyId ? { companyId } : {}),
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export type OAuthStateResult =
  | { valid: true; payload: OAuthStatePayload }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Verifies a state returned by Google.
 *
 * Signature is checked before expiry, and compared in constant time — a fast
 * "wrong at byte 3" answer is exactly what lets an attacker forge a signature
 * one byte at a time.
 */
export function verifyOAuthState(
  state: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): OAuthStateResult {
  if (!state) return { valid: false, reason: "malformed" };

  const separator = state.lastIndexOf(".");
  if (separator <= 0 || separator === state.length - 1) {
    return { valid: false, reason: "malformed" };
  }

  const encoded = state.slice(0, separator);
  const supplied = state.slice(separator + 1);
  const expected = sign(encoded, secret);

  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a signal, so
  // the lengths are compared first and both paths return the same reason.
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return { valid: false, reason: "bad-signature" };
  }

  const decoded = base64UrlDecode(encoded);
  if (!decoded) return { valid: false, reason: "malformed" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(decoded) as OAuthStatePayload;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    typeof payload?.nonce !== "string" ||
    typeof payload?.userId !== "string" ||
    typeof payload?.expiresAt !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (payload.expiresAt <= now) return { valid: false, reason: "expired" };

  return { valid: true, payload };
}
