/**
 * كل رمز QR يُعرض في الواجهة محجوب عن تسجيل الجلسات في PostHog.
 *
 * Codex review, PR #258: the Apple Pay handoff QR encodes the bearer payment
 * link as SVG path geometry, and the WhatsApp pairing QR is a `data:` image of
 * a live credential. Text and attribute masking cannot make either
 * undecodable; only rrweb's block class (`ph-no-capture`) replaces the element
 * with a blank box. This scan fails the build when a component renders a QR
 * without it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
// A rendered QR: the qrcode.react components, or an image built from a data URL.
const QR_RENDER = /<QRCode(?:SVG|Canvas)\b|src=\{[^}]*data:image\//g;
// The block class inside an actual className string — a comment that merely
// mentions ph-no-capture does not count (Codex review, PR #258).
const BLOCK_CLASS = /className="[^"]*\bph-no-capture\b[^"]*"/g;
// How far a QR may sit from its block class: the class is on the element
// itself or on a wrapper a few lines above it.
const BEFORE_WINDOW = 600;
const AFTER_WINDOW = 300;

/** يجمع مسارات مكوّنات الواجهة (لا الاختبارات) تحت مجلد. */
function componentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return componentFiles(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

/** يرجع كل موضع يُعرض فيه رمز QR دون صنف الحجب قريبًا منه، بصيغة ملف:موضع. */
function unblockedQrRenders(): string[] {
  return componentFiles(SRC).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const blockAt = [...source.matchAll(BLOCK_CLASS)].map((match) => match.index);
    return [...source.matchAll(QR_RENDER)]
      .filter(
        (qr) =>
          !blockAt.some((at) => at >= qr.index - BEFORE_WINDOW && at <= qr.index + AFTER_WINDOW),
      )
      .map((qr) => `${toRepoPath(path)}:${qr.index}`);
  });
}

/** يحوّل المسار إلى صيغة ثابتة بشرطات أمامية على كل الأنظمة. */
function toRepoPath(path: string): string {
  return relative(SRC, path).replace(/\\/g, "/");
}

describe("session replay", () => {
  it("never records a QR code: every component rendering one uses ph-no-capture", () => {
    expect(unblockedQrRenders()).toEqual([]);
  });

  it("still finds the QR renders it guards, so the scan has not gone blind", () => {
    const guarded = componentFiles(SRC)
      .filter((path) => readFileSync(path, "utf8").search(QR_RENDER) !== -1)
      .map(toRepoPath);

    expect(guarded).toEqual(
      expect.arrayContaining([
        "components/admin/settings/WhatsAppCard.tsx",
        "components/portal/ApplePayQrDialog.tsx",
      ]),
    );
  });
});
