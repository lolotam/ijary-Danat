import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";

export type LightboxKind = "image" | "video" | "pdf";

export interface LightboxEntry {
  kind: LightboxKind;
  src: string;
  row: WhatsappMessageRow;
}

interface MediaLightboxProps {
  entry: LightboxEntry | null;
  onClose: () => void;
  onDownload: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
}

/**
 * نافذة معاينة موحّدة للصور والفيديو و PDF.
 *
 * الصورة تُعرض <img>، الفيديو <video controls autoPlay>، و PDF عبر
 * <iframe> أو <object> على رابط الـ Blob مع رسالة احتياطية إن فشل التضمين.
 * كل الأنواع تحتفظ بزرّي التنزيل والإغلاق وبنفس لغة التصميم.
 */
export function MediaLightbox({ entry, onClose, onDownload, downloadPending }: MediaLightboxProps) {
  const { t } = useI18n();
  const titleKey =
    entry?.kind === "video"
      ? "inbox.whatsapp.viewVideo"
      : entry?.kind === "pdf"
        ? "inbox.whatsapp.viewPdf"
        : "inbox.whatsapp.viewImage";

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl border-0 bg-black/90 p-2">
        <DialogHeader className="sr-only">
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        {entry ? (
          <div className="flex flex-col items-center gap-3">
            {entry.kind === "image" ? (
              <img
                src={entry.src}
                alt={entry.row.media_filename ?? t("inbox.whatsapp.viewImage")}
                className="max-h-[75vh] w-auto max-w-full rounded-md object-contain"
              />
            ) : entry.kind === "video" ? (
              <video
                src={entry.src}
                controls
                autoPlay
                playsInline
                className="max-h-[75vh] w-full max-w-full rounded-md bg-black"
              />
            ) : (
              <div className="flex max-h-[75vh] w-full flex-col">
                <iframe
                  src={entry.src}
                  title={entry.row.media_filename ?? t("inbox.whatsapp.viewPdf")}
                  className="h-[75vh] w-full rounded-md bg-white"
                />
                <object data={entry.src} type="application/pdf" className="hidden" aria-hidden>
                  <p className="text-sm text-white/80">{t("inbox.whatsapp.pdfFallback")}</p>
                </object>
              </div>
            )}
            <div className="flex gap-2 pb-1">
              <Button
                variant="secondary"
                disabled={downloadPending}
                onClick={() => onDownload(entry.row)}
              >
                <Download className="size-4" />
                {entry.kind === "image"
                  ? t("inbox.whatsapp.downloadImage")
                  : t("inbox.whatsapp.downloadFile")}
              </Button>
              <Button variant="outline" onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
