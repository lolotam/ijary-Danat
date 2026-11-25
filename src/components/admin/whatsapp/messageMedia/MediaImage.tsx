import { useRef } from "react";
import { FileText } from "lucide-react";

import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import { useObjectUrl, useWhatsAppMediaBlob } from "@/hooks/useWhatsAppInbox";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import { useI18n } from "@/i18n/provider";

interface MediaImageProps {
  row: WhatsappMessageRow;
  onOpen: (row: WhatsappMessageRow, src: string) => void;
}

/**
 * يعرض صورة واتساب مصغّرة داخل الفقاعة ويفتح المعاينة الكبيرة عند النقر.
 *
 * يستخدم خط الأنابيب الموحّد بالـ Blobs (لا data:URL) حتى لا تُحبس سلاسل
 * base64 الضخمة في الكاش، ويؤجل الجلب حتى ظهور العنصر في منطقة العرض
 * عبر useInViewOnce لتجنب تنزيل كل الصور عند فتح الخيط.
 */
export function MediaImage({ row, onOpen }: MediaImageProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInViewOnce(ref);
  const media = useWhatsAppMediaBlob(row.message_id, visible);
  const url = useObjectUrl(media.data?.blob);

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

  if (media.isError || !url) {
    return (
      <div
        ref={ref}
        className="mb-0.5 flex h-40 w-56 max-w-full items-center justify-center rounded-md bg-black/10 dark:bg-white/10"
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
        className="mb-0.5 block overflow-hidden rounded-md"
        aria-label={t("inbox.whatsapp.viewImage")}
      >
        <img
          src={url}
          alt={row.media_filename ?? t("inbox.whatsapp.viewImage")}
          loading="lazy"
          className="max-h-72 w-auto max-w-full rounded-md object-contain"
        />
      </button>
    </div>
  );
}
