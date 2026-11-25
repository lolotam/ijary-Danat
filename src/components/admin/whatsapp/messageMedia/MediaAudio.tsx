import { useRef } from "react";
import { Download, FileText } from "lucide-react";

import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";

import { MediaDocumentChip } from "./MediaDocumentChip";
import { useObjectUrl, useWhatsAppMediaBlob } from "@/hooks/useWhatsAppInbox";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import { useI18n } from "@/i18n/provider";

interface MediaAudioProps {
  row: WhatsappMessageRow;
  onDownload: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
}

/**
 * يعرض رسالة صوتية قابلة للتشغيل داخل الفقاعة دون الحاجة للتنزيل.
 *
 * يستخدم عنصر <audio> الأصلي بلا مشغّل مخصص. الجلب مؤجل حتى ظهور الفقاعة في
 * العرض، وهذه هي البوابة الحقيقية للتحميل: المصدر هو Blob محلي بالفعل، فلا
 * يوفّر preload شيئاً بعد أن جلبه الخطّاف.
 *
 * زر التنزيل يبقى إلى جانب المشغّل: الشريحة القديمة كانت السبيل الوحيد لحفظ
 * رسالة صوتية، وإبدالها بمشغّل وحده كان سيسحب إجراءً موجوداً — الفيديو و PDF
 * يحتفظان بزر التنزيل داخل Lightbox، والصوت لا Lightbox له.
 */
export function MediaAudio({ row, onDownload, downloadPending }: MediaAudioProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInViewOnce(ref);
  const media = useWhatsAppMediaBlob(row.message_id, visible);
  const url = useObjectUrl(media.data?.blob);
  const label = row.media_filename?.trim() ? row.media_filename : t("inbox.whatsapp.voiceMessage");

  if (!visible || media.isLoading) {
    return (
      <div
        ref={ref}
        className="mb-0.5 flex w-64 max-w-full animate-pulse items-center justify-center rounded-md bg-black/10 px-3 py-3 dark:bg-white/10"
      >
        <FileText className="size-4 opacity-40" />
        <span className="ms-2 text-xs opacity-60">{t("inbox.whatsapp.loadingPreview")}</span>
      </div>
    );
  }

  // فشل الجلب يعيد شريحة التنزيل، لا رسالة خطأ وحدها: الأصل كان شريحة قابلة
  // للنقر، ومسار الفشل هو أكثر ما يحتاج فيه المستخدم محاولة أخرى.
  if (media.isError || !url) {
    return (
      <div ref={ref}>
        <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
        <p className="mt-1 text-xs opacity-60">{t("inbox.whatsapp.mediaError")}</p>
      </div>
    );
  }

  return (
    <div ref={ref} className="mb-0.5 w-64 max-w-full rounded-md bg-black/5 p-2 dark:bg-white/10">
      <div className="mb-1 flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs opacity-70" dir="auto">
          {label}
        </p>
        <button
          type="button"
          disabled={downloadPending}
          onClick={() => onDownload(row)}
          className="shrink-0 rounded p-1 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
          aria-label={t("inbox.whatsapp.downloadFile")}
          title={t("inbox.whatsapp.downloadFile")}
        >
          <Download className="size-3.5" />
        </button>
      </div>
      <audio controls preload="metadata" src={url} className="w-full">
        {t("inbox.whatsapp.playAudio")}
      </audio>
    </div>
  );
}
