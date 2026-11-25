import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * يبحث عن ملف الشعار في المسارات الممكنة: شجرة التطوير أو مخرجات البناء.
 *
 * The production image copies only `.output`, where Nitro emits the asset at
 * `.output/public/...`; the dev server serves it from `public/...`. Reading
 * one path only worked locally and raised ENOENT in the container.
 */
function readLogo(): Buffer {
  const candidates = [
    join(process.cwd(), ".output/public/contract-builder/danat-logo.png"),
    join(process.cwd(), "public/contract-builder/danat-logo.png"),
    join(process.cwd(), "../public/contract-builder/danat-logo.png"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate);
    } catch {
      // Try the next layout; the throw below names every path that was tried.
    }
  }
  throw new Error(`contract logo not found; tried: ${candidates.join(", ")}`);
}

/**
 * شعار الشركة كـ data URI حتى يطبعه Chromium دون طلب الشبكة.
 *
 * Headless Chromium in the container has no route to the app's public URL, so
 * the server function must inline the PNG. The preview iframe still uses the
 * public path.
 */
export const CONTRACT_LOGO_DATA_URI = `data:image/png;base64,${readLogo().toString("base64")}`;
