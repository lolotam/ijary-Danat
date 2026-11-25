import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * يثبت أن مُصيّرات الوسائط موصولة هيكلياً:
 * - MessageBubble يفوّض إلى كل مُصيّر حسب النوع
 * - الخط الموحّد بالـ Blobs مستخدم لا data:URL القديم
 * - useInViewOnce كبوابة للتحميل، وuseObjectUrl لإدارة الروابط
 * - MediaPdf يستورد pdfjs ديناميكياً فقط
 * - MediaLightbox يغطي الصورة والفيديو و PDF
 */
const bubble = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/MessageBubble.tsx"),
  "utf8",
);
const thread = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/WhatsAppThread.tsx"),
  "utf8",
);
const hook = readFileSync(resolve(process.cwd(), "src/hooks/useWhatsAppInbox.ts"), "utf8");
const image = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/messageMedia/MediaImage.tsx"),
  "utf8",
);
const video = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/messageMedia/MediaVideo.tsx"),
  "utf8",
);
const audio = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/messageMedia/MediaAudio.tsx"),
  "utf8",
);
const pdf = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/messageMedia/MediaPdf.tsx"),
  "utf8",
);
const lightbox = readFileSync(
  resolve(process.cwd(), "src/components/admin/whatsapp/messageMedia/MediaLightbox.tsx"),
  "utf8",
);
const inView = readFileSync(resolve(process.cwd(), "src/hooks/useInViewOnce.ts"), "utf8");
const objectUrl = readFileSync(resolve(process.cwd(), "src/hooks/useObjectUrl.ts"), "utf8");

describe("whatsapp media wiring", () => {
  test("MessageBubble يفوّض إلى كل مُصيّر", () => {
    expect(bubble).toMatch(/resolveMediaKind/);
    expect(bubble).toMatch(/MediaImage/);
    expect(bubble).toMatch(/MediaVideo/);
    expect(bubble).toMatch(/MediaAudio/);
    expect(bubble).toMatch(/MediaPdf/);
    expect(bubble).toMatch(/MediaDocumentChip/);
  });

  test("الخط الموحّد بالـ Blobs: useWhatsAppMediaBlob بمفتاح whatsapp-media و staleTime Infinity", () => {
    expect(hook).toMatch(/useWhatsAppMediaBlob/);
    expect(hook).toMatch(/\["whatsapp-media",\s*messageId\]/);
    expect(hook).toMatch(/staleTime:\s*Infinity/);
    expect(hook).toMatch(/retry:\s*1/);
    expect(hook).toMatch(/base64ToBlobInline|base64ToBlob/);
    expect(hook).toMatch(/Blob/);
  });

  test("useObjectUrl ينشئ رابطاً ويلغيه عند التغيير/الإزالة", () => {
    expect(hook).toMatch(/useObjectUrl/);
    expect(hook).toMatch(/URL\.createObjectURL/);
    expect(hook).toMatch(/URL\.revokeObjectURL/);
    expect(objectUrl).toMatch(/URL\.createObjectURL/);
    expect(objectUrl).toMatch(/URL\.revokeObjectURL/);
  });

  test("useInViewOnce يستخدم IntersectionObserver ويعود true بلا API", () => {
    expect(hook).toMatch(/useInViewOnce/);
    expect(inView).toMatch(/IntersectionObserver/);
    expect(inView).toMatch(/rootMargin/);
    // hook may re-export; accept either direct implementation or re-export
    expect(hook.includes("IntersectionObserver") || hook.includes('from "./useInViewOnce"')).toBe(
      true,
    );
  });

  test("الصور والفيديو والصوت و PDF يؤجلون الجلب حتى الظهور", () => {
    expect(image).toMatch(/useInViewOnce/);
    expect(video).toMatch(/useInViewOnce/);
    expect(audio).toMatch(/useInViewOnce/);
    expect(pdf).toMatch(/useInViewOnce/);
    expect(image).toMatch(/useWhatsAppMediaBlob/);
    expect(video).toMatch(/useWhatsAppMediaBlob/);
    expect(audio).toMatch(/useWhatsAppMediaBlob/);
    expect(pdf).toMatch(/useWhatsAppMediaBlob/);
  });

  test("MediaVideo يستخدم preload=metadata و aspect-ratio من onLoadedMetadata", () => {
    expect(video).toMatch(/preload="metadata"/);
    expect(video).toMatch(/aspectRatio|aspect-ratio/);
    expect(video).toMatch(/onLoadedMetadata/);
    expect(video).toMatch(/toAspectRatio/);
  });

  test("MediaAudio يستخدم عنصر audio الأصلي مع controls و preload=metadata", () => {
    expect(audio).toMatch(/<audio/);
    expect(audio).toMatch(/controls/);
    expect(audio).toMatch(/preload="metadata"/);
    expect(audio).toMatch(/voiceMessage/);
  });

  test("MediaPdf يستورد pdfjs ديناميكياً فقط داخل effect ويضبط workerSrc", () => {
    expect(pdf).toMatch(/import\("pdfjs-dist"\)/);
    expect(pdf).toMatch(/pdf\.worker\.min\.mjs\?url/);
    expect(pdf).toMatch(/GlobalWorkerOptions\.workerSrc/);
    expect(pdf).toMatch(/getDocument/);
    expect(pdf).toMatch(/getPage\(1\)/);
    expect(pdf).toMatch(/getViewport/);
    expect(pdf).toMatch(/toDataURL/);
    // لا يوجد استيراد علوي يكسر SSR
    expect(pdf).not.toMatch(/^import\s+.*from\s+["']pdfjs-dist["']/m);
  });

  test("MediaLightbox يغطي image و video و pdf مع أزرار التنزيل والإغلاق", () => {
    expect(lightbox).toMatch(/LightboxKind/);
    expect(lightbox).toMatch(/"image"\s*\|\s*"video"\s*\|\s*"pdf"/);
    expect(lightbox).toMatch(/<img/);
    expect(lightbox).toMatch(/<video/);
    expect(lightbox).toMatch(/<iframe/);
    expect(lightbox).toMatch(/downloadFile|downloadImage/);
    expect(lightbox).toMatch(/common\.close/);
  });

  test("WhatsAppThread يستخدم MessageBubble و MediaLightbox ولا يحتوي منطق فقاعة قديم", () => {
    expect(thread).toMatch(/MessageBubble/);
    expect(thread).toMatch(/MediaLightbox/);
    expect(thread).not.toMatch(/useWhatsAppImagePreview/);
    expect(thread).not.toMatch(/isImage.*image.*sticker/);
  });

  test("WhatsAppThread لم يعد يحتوي Lightbox الصور القديم inline", () => {
    expect(thread).not.toMatch(/Full-size image lightbox/);
  });

  // Codex on PR #179, twice: replacing the download chip with a player removed
  // the only way to save a voice note, and the first fix left the failure path
  // still offering nothing. Every audio and video state must keep a download.
  test("الصوت والفيديو يحتفظان بالتنزيل في مسار الفشل", () => {
    for (const source of [audio, video]) {
      expect(source).toMatch(/media\.isError/);
      expect(source).toMatch(/MediaDocumentChip/);
      expect(source).toMatch(/onDownload=\{onDownload\}/);
      expect(source).toMatch(/downloadPending=\{downloadPending\}/);
    }
  });

  test("الفقاعة تمرّر onDownload إلى الصوت والفيديو", () => {
    // بدون التمرير لا يُصرَّف الملف أصلاً — الشريحة تُعرض بزر معطّل بلا فائدة.
    expect(bubble).toMatch(/<MediaAudio[^>]*onDownload=\{onDownload\}/s);
    expect(bubble).toMatch(/<MediaVideo[\s\S]*?onDownload=\{onDownload\}/);
  });
});
