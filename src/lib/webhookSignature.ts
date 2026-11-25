/**
 * أوّليات التحقق من تواقيع الويب هوك، مشتركة بين ماي فاتورة وResend.
 *
 * Both providers sign with HMAC-SHA256 and compare base64, and they differ only
 * in *what* they sign — MyFatoorah a canonical `key=value` string, Resend the
 * raw body prefixed with the delivery id and timestamp. Keeping one copy of the
 * primitives means a fix to the comparison (a timing leak, an encoding bug)
 * cannot land in one endpoint and be forgotten in the other.
 */

/**
 * يوقّع نصًّا بمفتاح ثنائي ويعيد الناتج بترميز base64.
 */
export async function hmacBase64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...signed));
}

/**
 * يقارن نصّين بزمن ثابت لا يتسرّب منه موضع أول اختلاف.
 *
 * A plain `===` returns as soon as two characters differ, and that timing is
 * enough to recover a signature byte by byte without ever knowing the secret.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * يفكّ ترميز base64 إلى بايتات، ويعيد null إن كان النص غير صالح.
 *
 * Accepts the base64url alphabet too, and pads a string that arrived unpadded —
 * `atob` rejects both, and secrets are copied out of dashboards by hand.
 */
export function decodeBase64(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
