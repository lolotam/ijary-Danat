import { Download, FileText } from "lucide-react";

import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";

interface MediaDocumentChipProps {
  row: WhatsappMessageRow;
  onDownload: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
}

/**
 * شريحة تنزيل للمستندات غير القابلة للمعاينة (docx, xlsx, zip ...).
 *
 * تبقي السلوك الحالي بلا تغيير: زر واحد يحوّل base64 إلى ملف عبر
 * useDownloadWhatsAppMedia. لا يُجلب شيء تلقائياً حتى النقر.
 */
export function MediaDocumentChip({ row, onDownload, downloadPending }: MediaDocumentChipProps) {
  return (
    <button
      type="button"
      disabled={downloadPending}
      onClick={() => onDownload(row)}
      className="mb-0.5 flex w-full items-center gap-1.5 rounded-md bg-black/5 px-2 py-1.5 text-start text-sm transition-colors hover:bg-black/10 disabled:opacity-60 dark:bg-white/10 dark:hover:bg-white/15"
    >
      <FileText className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {row.media_filename ?? `[${row.media_type}]`}
      </span>
      <Download className="size-3.5 shrink-0 opacity-70" />
    </button>
  );
}
