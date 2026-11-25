async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Constant-time compare of a caller-supplied cron secret against CRON_SECRET.
 *
 * Both sides are hashed first so the comparison is always over 32 bytes: a short
 * or malformed header cannot leak the real secret's length, and the XOR-accumulate
 * loop never short-circuits on the first differing byte (which would let a caller
 * brute-force the secret one byte at a time by timing the response).
 */
export async function isValidCronSecret(supplied: string, expected: string): Promise<boolean> {
  const [suppliedHash, expectedHash] = await Promise.all([sha256(supplied), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= expectedHash[index] ^ suppliedHash[index];
  }
  return difference === 0;
}

/** Reads the shared secret from `Authorization: Bearer <secret>`. */
export function readCronSecretHeader(request: Request): string | null {
  const header =
    request.headers.get("authorization") ?? request.headers.get("Authorization") ?? null;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const secret = header.slice("bearer ".length).trim();
  return secret.length > 0 ? secret : null;
}
