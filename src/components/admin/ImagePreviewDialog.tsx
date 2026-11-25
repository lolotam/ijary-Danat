import { useState, type MouseEvent } from "react";
import { Eye } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export type ImagePreviewDialogProps = {
  url: string;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * يعرض صورة عامة داخل حوار محدود بإطار النافذة.
 *
 * These landing thumbnails are already public URLs. AttachmentPreviewDialog
 * signs a storage path and returns HTTP 500 if that URL is passed as a path.
 */
export function ImagePreviewDialog({ url, alt, open, onOpenChange }: ImagePreviewDialogProps) {
  const { t } = useI18n();
  const title = alt?.trim() || t("common.preview");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-fit max-w-[min(96vw,80rem)]">
        <DialogHeader>
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        <img src={url} alt={alt ?? ""} className="max-h-[80vh] max-w-full object-contain" />
      </DialogContent>
    </Dialog>
  );
}

/**
 * زر عين في منتصف الصورة يفتح المعاينة دون إطلاق نقر البطاقة.
 *
 * Hidden until hover on fine pointers; `pointer-coarse:` keeps it visible on
 * touch so there is no hover state to reveal it.
 */
function ImagePreviewOverlay({ url, alt }: { url: string; alt?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  /**
   * يفتح المعاينة ويوقف انتشار النقر حتى لا تُفعَّل البطاقة نفسها.
   */
  function openPreview(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-[1] flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        aria-label={t("common.preview")}
        onClick={openPreview}
      >
        <Eye className="size-5" />
      </button>
      <ImagePreviewDialog url={url} alt={alt} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * صورة مصغّرة مع زر المعاينة عندما يكون المصدر عنوان URL عاماً جاهزاً.
 */
export function PreviewableImage({
  url,
  alt,
  className,
  imageClassName,
}: {
  url: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div className={cn("group relative overflow-hidden rounded border bg-muted/30", className)}>
      <img src={url} alt={alt ?? ""} className={imageClassName} />
      <ImagePreviewOverlay url={url} alt={alt} />
    </div>
  );
}
