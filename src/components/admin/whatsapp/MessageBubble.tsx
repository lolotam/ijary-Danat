import { AlertCircle, Check, CheckCheck, Download, FileText, Forward, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LinkifiedText } from "@/components/ui/linkified-text";
import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

import { resolveMediaKind } from "./messageMedia/mediaKind";
import { MediaAudio } from "./messageMedia/MediaAudio";
import { MediaDocumentChip } from "./messageMedia/MediaDocumentChip";
import { MediaImage } from "./messageMedia/MediaImage";
import { MediaPdf } from "./messageMedia/MediaPdf";
import { MediaVideo } from "./messageMedia/MediaVideo";
import type { LightboxEntry } from "./messageMedia/MediaLightbox";

interface MessageBubbleProps {
  row: WhatsappMessageRow;
  timeTag: string;
  onDownload: (row: WhatsappMessageRow) => void;
  onOpenMedia: (entry: LightboxEntry) => void;
  onForward: (row: WhatsappMessageRow) => void;
  onDelete: (row: WhatsappMessageRow) => void;
  downloadPending: boolean;
  canForward: boolean;
}

/**
 * يختار أيقونة الإقرار حسب حالة الرسالة كما في واتساب.
 */
function StatusTicks({ status }: { status: string }) {
  if (status === "failed") {
    return <AlertCircle className="size-3.5 text-red-500" />;
  }
  if (status === "read") {
    return <CheckCheck className="size-3.5 text-[#53bdeb]" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="size-3.5 text-black/45 dark:text-white/50" />;
  }
  return <Check className="size-3.5 text-black/45 dark:text-white/50" />;
}

/**
 * فقاعة رسالة بأسلوب واتساب ويب مع أزرار إجراء تظهر عند المرور.
 *
 * تختار مُصيّر الوسائط من نوع الرسالة وتفوّض العرض له؛ الفقاعة نفسها
 * لا تعرف كيف يُحمّل PDF أو كيف يُحسب aspect-ratio الفيديو.
 */
export function MessageBubble({
  row,
  timeTag,
  onDownload,
  onOpenMedia,
  onForward,
  onDelete,
  downloadPending,
  canForward,
}: MessageBubbleProps) {
  const { t } = useI18n();
  const outbound = row.direction === "outbound";
  const kind = resolveMediaKind(row);
  const time = new Intl.DateTimeFormat(timeTag, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(row.sent_at),
  );

  let mediaSlot: React.ReactNode = null;
  if (kind === "image") {
    mediaSlot = (
      <MediaImage row={row} onOpen={(r, src) => onOpenMedia({ kind: "image", src, row: r })} />
    );
  } else if (kind === "video") {
    mediaSlot = (
      <MediaVideo
        row={row}
        onOpen={(r, src) => onOpenMedia({ kind: "video", src, row: r })}
        onDownload={onDownload}
        downloadPending={downloadPending}
      />
    );
  } else if (kind === "audio") {
    mediaSlot = <MediaAudio row={row} onDownload={onDownload} downloadPending={downloadPending} />;
  } else if (kind === "pdf") {
    mediaSlot = (
      <MediaPdf
        row={row}
        onOpen={(r, src) => onOpenMedia({ kind: "pdf", src, row: r })}
        onDownload={onDownload}
        downloadPending={downloadPending}
      />
    );
  } else if (kind === "document") {
    mediaSlot = (
      <MediaDocumentChip row={row} onDownload={onDownload} downloadPending={downloadPending} />
    );
  } else if (row.media_type) {
    // Fallback for unknown media_type values — keep download chip
    mediaSlot = (
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

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1",
        outbound ? "justify-end" : "justify-start",
      )}
    >
      {outbound && canForward ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={t("inbox.whatsapp.forward")}
            onClick={() => onForward(row)}
          >
            <Forward className="size-3.5 rtl:-scale-x-100" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("common.delete")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onDelete(row)}>
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
      <div
        className={cn(
          "max-w-[65%] rounded-lg px-2.5 py-1.5 text-[14.2px] leading-[19px] shadow-sm",
          outbound
            ? "rounded-se-none bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]"
            : "rounded-ss-none bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]",
        )}
      >
        {mediaSlot}
        {row.body ? (
          <p className="whitespace-pre-wrap break-words" dir="auto">
            <LinkifiedText text={row.body} />
          </p>
        ) : null}
        <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-black/45 dark:text-white/50">
          <span dir="ltr">{time}</span>
          {outbound ? <StatusTicks status={row.status} /> : null}
        </span>
      </div>
      {!outbound && canForward ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={t("inbox.whatsapp.forward")}
            onClick={() => onForward(row)}
          >
            <Forward className="size-3.5 rtl:-scale-x-100" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("common.delete")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => onDelete(row)}>
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  );
}
