import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";

import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import { useObjectUrl, useWhatsAppMediaBlob } from "@/hooks/useWhatsAppInbox";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import { useI18n } from "@/i18n/provider";

import { MediaDocumentChip } from "./MediaDocumentChip";
import { isPdfCandidate } from "./mediaKind";

interface MediaPdfProps {
  row: WhatsappMessageRow;
  onOpen: (row: WhatsappMessageRow, src: string) => void;
  onDownload: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
}

/**
 * يعرض معاينة مصغّرة للصفحة الأولى من PDF داخل الفقاعة.
 *
 * يستورد pdfjs-dist ديناميكياً داخل effect فقط حتى لا يكسر SSR ولا يضخّم
 * حزمة الخيط؛ يرسم على canvas خارج الشاشة ثم يحوّلها إلى data URL للعرض.
 * إن فشل pdfjs (مشفر/تالف) يعود لشريحة المستند العادية فلا يُفرغ الخيط.
 */
export function MediaPdf({ row, onOpen, onDownload, downloadPending }: MediaPdfProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInViewOnce(ref);
  const media = useWhatsAppMediaBlob(row.message_id, visible);
  const url = useObjectUrl(media.data?.blob);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // قبل الجلب: ترشيح بالاسم (أو غيابه). بعد الجلب: MIME هو الحكم، فملف مسمّى
  // ‎.pdf‎ لكنه ليس PDF يعود للشريحة، ومستند بلا اسم تبيّن أنه PDF يُعرض.
  const isActuallyPdf = media.data
    ? media.data.mimeType.split(";")[0].trim().toLowerCase() === "application/pdf"
    : isPdfCandidate(row);

  useEffect(() => {
    if (!visible) return;
    if (!media.data?.blob) return;
    if (!isActuallyPdf) return;

    let cancelled = false;
    let loadingTask: { destroy: () => void } | null = null;
    let renderTask: { cancel: () => void } | null = null;

    /**
     * ترسم الصفحة الأولى من PDF على canvas خارج الشاشة لإنتاج مصغّرة.
     *
     * تستورد pdfjs ديناميكياً داخل التأثير فقط لتجنب كسر SSR، وتُجهّز
     * workerSrc في نفس الاستيراد. الإلغاء النظيف يمنع setState بعد إزالة المكوّن.
     */
    async function render() {
      try {
        const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = (workerModule as { default: string }).default;

        const bytes = new Uint8Array(await media.data!.blob.arrayBuffer());
        if (cancelled) return;

        const docTask = getDocument({ data: bytes });
        loadingTask = docTask as unknown as { destroy: () => void };
        const doc = await docTask.promise;
        if (cancelled) {
          (doc as unknown as { destroy: () => void }).destroy();
          return;
        }
        const page = await doc.getPage(1);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setFailed(true);
          (doc as unknown as { destroy: () => void }).destroy();
          return;
        }
        const task = page.render({ canvas, canvasContext: ctx, viewport } as never);
        renderTask = task as unknown as { cancel: () => void };
        await task.promise;
        if (cancelled) {
          (doc as unknown as { destroy: () => void }).destroy();
          return;
        }
        const dataUrl = canvas.toDataURL("image/png");
        if (!cancelled) setThumb(dataUrl);
        (doc as unknown as { destroy: () => void }).destroy();
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    void render();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // تجاهل إلغاء مهمة لم تبدأ بعد
      }
      try {
        loadingTask?.destroy();
      } catch {
        // تجاهل تدمير مهمة تحميل أُلغيت
      }
    };
  }, [visible, media.data, isActuallyPdf]);

  if (!visible || media.isLoading) {
    return (
      <div
        ref={ref}
        className="mb-0.5 flex h-40 w-56 max-w-full animate-pulse items-center justify-center rounded-md bg-black/10 dark:bg-white/10"
      >
        <FileText className="size-5 opacity-40" />
      </div>
    );
  }

  if (media.isError) {
    return (
      <div ref={ref}>
        <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
        <p className="mt-1 text-xs opacity-60">{t("inbox.whatsapp.pdfError")}</p>
      </div>
    );
  }

  if (!isActuallyPdf) {
    return (
      <div ref={ref}>
        <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
      </div>
    );
  }

  if (failed) {
    return (
      <div ref={ref}>
        <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
        <p className="mt-1 text-xs opacity-60">{t("inbox.whatsapp.pdfError")}</p>
      </div>
    );
  }

  if (!thumb || !url) {
    return (
      <div
        ref={ref}
        className="mb-0.5 flex h-40 w-56 max-w-full animate-pulse items-center justify-center rounded-md bg-black/10 dark:bg-white/10"
      >
        <FileText className="size-5 opacity-40" />
      </div>
    );
  }

  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={() => onOpen(row, url)}
        className="mb-0.5 block overflow-hidden rounded-md border border-black/10 dark:border-white/10"
        aria-label={t("inbox.whatsapp.viewPdf")}
      >
        <img
          src={thumb}
          alt={row.media_filename ?? t("inbox.whatsapp.viewPdf")}
          loading="lazy"
          className="max-h-72 w-auto max-w-full object-contain"
        />
      </button>
      <p className="truncate text-xs opacity-70" dir="auto">
        {row.media_filename ?? t("inbox.whatsapp.viewPdf")}
      </p>
    </div>
  );
}
