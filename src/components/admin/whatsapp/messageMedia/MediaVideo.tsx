import { useRef, useState } from "react";
import { FileText, Play } from "lucide-react";

import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import { useObjectUrl, useWhatsAppMediaBlob } from "@/hooks/useWhatsAppInbox";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import { useI18n } from "@/i18n/provider";

import { MediaDocumentChip } from "./MediaDocumentChip";
import { toAspectRatio } from "./videoAspect";

interface MediaVideoProps {
  row: WhatsappMessageRow;
  onOpen: (row: WhatsappMessageRow, src: string) => void;
  onDownload: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
}

/**
 * يعرض فيديو واتساب كبطاقة مصغّرة بنسبة عرض حقيقية مع شارة تشغيل.
 *
 * الهيكل يبدأ 4:3 محايداً ثم يُصحَّح إلى aspect-ratio الحقيقي بعد
 * onLoadedMetadata، لأن أبعاد الفيديو غير مخزّنة في قاعدة البيانات.
 * النقر يفتح Lightbox بمشغّل كامل. الجلب مؤجل حتى الظهور في العرض — وهذه هي
 * البوابة الحقيقية، فالمصدر Blob محلي جلبه الخطّاف قبل أن يراه العنصر.
 */
export function MediaVideo({ row, onOpen, onDownload, downloadPending }: MediaVideoProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInViewOnce(ref);
  const media = useWhatsAppMediaBlob(row.message_id, visible);
  const url = useObjectUrl(media.data?.blob);
  const [aspect, setAspect] = useState<string | null>(null);

  if (!visible || media.isLoading) {
    return (
      <div
        ref={ref}
        className="mb-0.5 flex aspect-[4/3] w-56 max-w-full animate-pulse items-center justify-center rounded-md bg-black/10 dark:bg-white/10"
      >
        <FileText className="size-5 opacity-40" />
      </div>
    );
  }

  // نفس قاعدة الصوت: الفشل يترك شريحة تنزيل قابلة للنقر، فالمشغّل الذي لا
  // يُحمَّل يجب ألا يسحب معه الطريق الوحيد للحصول على الملف.
  if (media.isError || !url) {
    return (
      <div ref={ref}>
        <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
        <p className="mt-1 text-xs opacity-60">{t("inbox.whatsapp.mediaError")}</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="mb-0.5 w-56 max-w-full">
      <button
        type="button"
        onClick={() => onOpen(row, url)}
        className="relative block w-full overflow-hidden rounded-md bg-black"
        style={aspect ? { aspectRatio: aspect } : { aspectRatio: "4 / 3" }}
        aria-label={t("inbox.whatsapp.viewVideo")}
      >
        <video
          src={url}
          preload="metadata"
          muted
          playsInline
          className="h-full w-full object-contain"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const next = toAspectRatio(video.videoWidth, video.videoHeight);
            if (next) setAspect(next);
          }}
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-white/90 shadow">
            <Play className="size-5 fill-black text-black rtl:-scale-x-100" />
          </span>
        </span>
      </button>
    </div>
  );
}
