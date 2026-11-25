import { describe, expect, test } from "vitest";

import { isPdfCandidate, resolveMediaKind } from "./mediaKind";

/**
 * يثبت أن resolveMediaKind يميّز الصور والفيديو والصوت و PDF والمستندات،
 * ويحترم كلاً من امتداد الاسم ونوع MIME العائد من الخادم.
 */
describe("resolveMediaKind", () => {
  test("image و sticker يعودان image", () => {
    expect(resolveMediaKind({ media_type: "image", media_filename: null })).toBe("image");
    expect(resolveMediaKind({ media_type: "sticker", media_filename: null })).toBe("image");
  });

  test("video يعود video", () => {
    expect(resolveMediaKind({ media_type: "video", media_filename: null })).toBe("video");
  });

  test("audio يعود audio", () => {
    expect(resolveMediaKind({ media_type: "audio", media_filename: null })).toBe("audio");
  });

  test("document باسم .pdf يعود pdf قبل الجلب", () => {
    expect(resolveMediaKind({ media_type: "document", media_filename: "report.pdf" })).toBe("pdf");
    expect(resolveMediaKind({ media_type: "document", media_filename: "REPORT.PDF" })).toBe("pdf");
    expect(resolveMediaKind({ media_type: "document", media_filename: "a.PdF" })).toBe("pdf");
  });

  test("document بامتداد آخر يعود document ولا يُجلب", () => {
    expect(resolveMediaKind({ media_type: "document", media_filename: "sheet.xlsx" })).toBe(
      "document",
    );
    expect(resolveMediaKind({ media_type: "document", media_filename: "archive.zip" })).toBe(
      "document",
    );
  });

  test("document بلا اسم يُرشَّح كـ pdf حتى يحكم MIME", () => {
    // واتساب يرسل كثيراً من المستندات بلا اسم — `extractMedia` يخزّن null —
    // وبدون هذا الترشيح لا يُجلب الملف أبداً فلا يُكتشف نوعه ولا تظهر معاينة.
    expect(resolveMediaKind({ media_type: "document", media_filename: null })).toBe("pdf");
    expect(resolveMediaKind({ media_type: "document", media_filename: "   " })).toBe("pdf");
    // وحين يعود MIME غير pdf يرجع للشريحة، فالترشيح لا يفرض معاينة كاذبة.
    expect(
      resolveMediaKind({ media_type: "document", media_filename: null }, "application/zip"),
    ).toBe("document");
  });

  test("MIME application/pdf يغلب الاسم — الحالة الكاذبة pdf لكنه ليس pdf", () => {
    expect(
      resolveMediaKind({ media_type: "document", media_filename: "report.pdf" }, "application/zip"),
    ).toBe("document");
  });

  test("MIME application/pdf يحوّل document عادي إلى pdf — الحالة الكاذبة docx لكنه pdf", () => {
    expect(
      resolveMediaKind({ media_type: "document", media_filename: "file.docx" }, "application/pdf"),
    ).toBe("pdf");
    expect(
      resolveMediaKind({ media_type: "document", media_filename: null }, "application/pdf"),
    ).toBe("pdf");
    expect(
      resolveMediaKind(
        { media_type: "document", media_filename: "file.docx" },
        "application/pdf; charset=binary",
      ),
    ).toBe("pdf");
  });

  test("null media_type يعود null (لا وسائط)", () => {
    expect(resolveMediaKind({ media_type: null, media_filename: null })).toBeNull();
  });

  test("معرف الوسائط غير معروف يعود document كافتراضي", () => {
    expect(resolveMediaKind({ media_type: "unknown", media_filename: "file.bin" })).toBe(
      "document",
    );
  });
});

/**
 * يثبت قاعدة الترشيح قبل الجلب وحدها: ما الذي يستحق تنزيلاً لاكتشاف نوعه.
 */
describe("isPdfCandidate", () => {
  test("المستندات فقط — لا صورة ولا فيديو ولا صوت", () => {
    expect(isPdfCandidate({ media_type: "image", media_filename: null })).toBe(false);
    expect(isPdfCandidate({ media_type: "video", media_filename: null })).toBe(false);
    expect(isPdfCandidate({ media_type: "audio", media_filename: null })).toBe(false);
    expect(isPdfCandidate({ media_type: null, media_filename: null })).toBe(false);
  });

  test("اسم ينتهي بـ .pdf أو غياب الاسم يُرشَّح", () => {
    expect(isPdfCandidate({ media_type: "document", media_filename: "عقد.pdf" })).toBe(true);
    expect(isPdfCandidate({ media_type: "document", media_filename: null })).toBe(true);
  });

  test("امتداد آخر لا يُرشَّح — لا نُنزّل كل مرفق بحثاً عن نوعه", () => {
    expect(isPdfCandidate({ media_type: "document", media_filename: "sheet.xlsx" })).toBe(false);
    expect(isPdfCandidate({ media_type: "document", media_filename: "a.pdf.zip" })).toBe(false);
  });
});
