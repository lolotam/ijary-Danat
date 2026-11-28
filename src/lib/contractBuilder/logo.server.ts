/**
 * شعار الشركة في العقد المطبوع: يُنزَّل من مخزن الشركة ويُضمَّن كـ data URI.
 *
 * Headless Chromium in the container has no route to the app's public URL, so
 * the server function must inline the image. The preview iframe still loads
 * the company's public URL directly.
 *
 * This file used to read one company's logo off disk and print it on every
 * company's contract. It now fetches the requesting company's own logo, and
 * every failure — no logo set, a URL outside the company's storage folder, a
 * network error, a non-image, an oversized file — prints no logo at all.
 */

const LOGO_BUCKET = "branding";
const PUBLIC_OBJECT_PREFIX = `/storage/v1/object/public/${LOGO_BUCKET}/`;
const LOGO_FETCH_TIMEOUT_MS = 5_000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * يستخرج مسار الشعار داخل مجلد الشركة في مخزن الهوية، أو null إن كان الرابط خارجه.
 *
 * Why not fetch `logo_url` as given: it is a free-text company setting, and a
 * server that fetches any URL staff type is a request forgery primitive into
 * the internal network. Only an object under `companies/<company_id>/` in the
 * public `branding` bucket is accepted, and the fetch below goes to the
 * server's own storage origin, never to the host named in the URL — which
 * also works where the public hostname does not resolve from the container.
 */
export function companyLogoObjectPath(
  logoUrl: string | null | undefined,
  companyId: string,
): string | null {
  if (!logoUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(logoUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(PUBLIC_OBJECT_PREFIX)) return null;
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(pathname.slice(PUBLIC_OBJECT_PREFIX.length));
  } catch {
    return null;
  }
  const segments = objectPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.length < 3 || segments[0] !== "companies" || segments[1] !== companyId) return null;
  return objectPath;
}

/**
 * ينزّل شعار الشركة من مخزنها ويرجعه data URI، أو null عند أي فشل.
 *
 * Fails closed: a contract without a logo is still a valid contract, while a
 * failed PDF over a missing image would block staff from printing at all.
 */
export async function contractLogoDataUri(
  logoUrl: string | null | undefined,
  companyId: string,
): Promise<string | null> {
  const objectPath = companyLogoObjectPath(logoUrl, companyId);
  const storageOrigin = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  if (!objectPath || !storageOrigin) return null;

  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const url = `${storageOrigin.replace(/\/+$/, "")}${PUBLIC_OBJECT_PREFIX}${encodedPath}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!contentType.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > LOGO_MAX_BYTES) return null;
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch (error) {
    console.warn("[contract] company logo fetch failed; printing without a logo", error);
    return null;
  }
}
