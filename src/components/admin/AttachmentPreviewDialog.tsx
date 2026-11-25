import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { FileTypeIcon } from "./FileTypeIcon";
import { documentDownloadName } from "@/lib/documentDownloadName";
import { downloadStoredFile } from "@/lib/downloadStoredFile";
import { useI18n } from "@/i18n/provider";

export interface AttachmentPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: string;
  path: string | null | undefined;
  mimeType?: string | null;
  title: string;
  subtitle?: string;
  /** Optional "Delete attachment" action — renders next to Download when provided. */
  onDelete?: () => void;
  deleteLabel?: string;
}

interface ResolvedUrl {
  url: string;
  isPdf: boolean;
  isImage: boolean;
}

export function AttachmentPreviewDialog({
  open,
  onOpenChange,
  bucket,
  path,
  mimeType,
  title,
  subtitle,
  onDelete,
  deleteLabel,
}: AttachmentPreviewDialogProps) {
  const { t } = useI18n();
  const [resolved, setResolved] = useState<ResolvedUrl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    if (!path) {
      setResolved(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.storage.from(bucket).createSignedUrl(path, 300);
      if (err) throw err;
      const lower = path.toLowerCase();
      const isPdf = mimeType === "application/pdf" || lower.endsWith(".pdf");
      const isImage =
        mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower);
      setResolved({ url: data.signedUrl, isPdf, isImage });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("attachment.loadFailed"));
      setResolved(null);
    } finally {
      setLoading(false);
    }
  }, [bucket, mimeType, path, t]);

  useEffect(() => {
    if (open) void resolve();
    else {
      setResolved(null);
      setError(null);
    }
  }, [open, resolve]);

  const handleDownload = useCallback(async () => {
    if (!path) return;
    try {
      // The stored leaf is a UUID; the dialog title is the human name, so the
      // saved file carries it (with the real extension from the path).
      await downloadStoredFile(bucket, path, documentDownloadName(title, path));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("attachment.downloadFailed"));
    }
  }, [bucket, path, t, title]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          {subtitle ? <DialogDescription className="truncate">{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-[40vh] w-full">
          {!path ? (
            <div className="flex h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground">
              <FileTypeIcon path={path} className="h-10 w-10 opacity-40" />
              <p className="text-sm">{t("attachment.none")}</p>
            </div>
          ) : loading ? (
            <div className="flex h-[40vh] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex h-[40vh] items-center justify-center text-sm text-destructive">
              {error}
            </div>
          ) : resolved ? (
            resolved.isPdf ? (
              <iframe
                src={resolved.url}
                title={title}
                className="h-[70vh] w-full rounded-lg border"
              />
            ) : resolved.isImage ? (
              <img
                src={resolved.url}
                alt={title}
                className="max-h-[70vh] w-full rounded-lg border object-contain"
              />
            ) : (
              <div className="flex h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground">
                <FileTypeIcon path={path} className="h-10 w-10" />
                <p className="text-sm">{t("attachment.previewUnavailable")}</p>
                <Button onClick={handleDownload} variant="outline" size="sm">
                  <Download className="mr-2 h-4 w-4" /> {t("documents.download")}
                </Button>
              </div>
            )
          ) : null}
        </div>
        {path ? (
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={handleDownload}>
              <Download className="mr-2 h-4 w-4" /> {t("documents.download")}
            </Button>
            {onDelete ? (
              <Button variant="destructive" onClick={onDelete}>
                {deleteLabel ?? t("attachment.delete")}
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
