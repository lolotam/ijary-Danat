import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { MessageBubble } from "@/components/admin/whatsapp/MessageBubble";
import { WhatsAppForwardDialog } from "@/components/admin/whatsapp/WhatsAppForwardDialog";
import {
  MediaLightbox,
  type LightboxEntry,
} from "@/components/admin/whatsapp/messageMedia/MediaLightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WhatsappMessageRow } from "@/integrations/supabase/database.types";
import {
  useDeleteWhatsAppMessage,
  useDownloadWhatsAppMedia,
  useMarkWhatsAppChatRead,
  useWhatsAppThread,
} from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";

interface WhatsAppThreadProps {
  chatNumber: string;
  canSend: boolean;
}

/**
 * يجمع الرسائل حسب اليوم لعرض فواصل التاريخ كما في واتساب ويب.
 */
function groupByDay(
  messages: WhatsappMessageRow[],
): Array<{ day: string; rows: WhatsappMessageRow[] }> {
  const groups: Array<{ day: string; rows: WhatsappMessageRow[] }> = [];
  for (const row of messages) {
    const day = row.sent_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

/**
 * خيط المحادثة: فواصل أيام، فقاعات مع تنزيل وإعادة توجيه، تحميل الأقدم،
 * وتعليم المقروء عند العرض. الفقاعة نفسها مفصولة في MessageBubble.
 */
export function WhatsAppThread({ chatNumber, canSend }: WhatsAppThreadProps) {
  const { t, locale } = useI18n();
  const thread = useWhatsAppThread(chatNumber);
  const markRead = useMarkWhatsAppChatRead();
  const download = useDownloadWhatsAppMedia();
  const deleteMessage = useDeleteWhatsAppMessage(chatNumber);
  const [forwardMessageId, setForwardMessageId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsappMessageRow | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastMarkedAtByChat = useRef<Record<string, string | null>>({});

  const timeTag = locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB";
  const dayFormatter = useMemo(
    () => new Intl.DateTimeFormat(timeTag, { dateStyle: "medium" }),
    [timeTag],
  );
  const groups = useMemo(() => groupByDay(thread.messages), [thread.messages]);

  const newestAt = thread.messages.length
    ? thread.messages[thread.messages.length - 1].sent_at
    : null;

  useEffect(() => {
    if (!newestAt) return;
    if (lastMarkedAtByChat.current[chatNumber] === newestAt) return;
    lastMarkedAtByChat.current[chatNumber] = newestAt;
    markRead.mutate({ chatNumber, seenAt: newestAt });
    bottomRef.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatNumber, newestAt]);

  useEffect(() => {
    markRead.mutate({ chatNumber, seenAt: new Date().toISOString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatNumber]);

  async function onDownload(row: WhatsappMessageRow) {
    try {
      await download.mutateAsync(row.message_id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onDelete(mode: "forMe" | "forEveryone") {
    if (!deleteTarget) return;
    try {
      await deleteMessage.mutateAsync({ messageId: deleteTarget.message_id, mode });
      toast.success(t("common.deleted"));
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[#efeae2] dark:bg-[#0b141a]">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {thread.hasOlder && thread.messages.length > 0 ? (
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="secondary"
              disabled={thread.isLoadingOlder}
              onClick={() => void thread.loadOlder()}
            >
              {t("inbox.whatsapp.loadOlder")}
            </Button>
          </div>
        ) : null}

        {thread.isLoading ? (
          <p className="text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : thread.error ? (
          <p className="text-center text-sm text-destructive">{t("common.error")}</p>
        ) : thread.messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            {t("inbox.whatsapp.emptyThread")}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.day} className="space-y-1.5">
              <div className="flex justify-center">
                <span className="rounded-md bg-white/80 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm dark:bg-[#182229]">
                  {dayFormatter.format(new Date(`${group.day}T00:00:00`))}
                </span>
              </div>
              {group.rows.map((row) => (
                <MessageBubble
                  key={row.id}
                  row={row}
                  timeTag={timeTag}
                  onDownload={(target) => void onDownload(target)}
                  onOpenMedia={(entry) => setLightbox(entry)}
                  onForward={(target) => setForwardMessageId(target.message_id)}
                  onDelete={(target) => setDeleteTarget(target)}
                  downloadPending={download.isPending}
                  canForward={canSend}
                />
              ))}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <WhatsAppForwardDialog
        messageId={forwardMessageId}
        onOpenChange={(open) => !open && setForwardMessageId(null)}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("inbox.whatsapp.deleteConfirm")}</p>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={deleteMessage.isPending}
                onClick={() => void onDelete("forMe")}
              >
                <Trash2 className="size-4" />
                {t("inbox.whatsapp.deleteForMe")}
              </Button>
              {deleteTarget?.direction === "outbound" ? (
                <Button
                  variant="destructive"
                  disabled={deleteMessage.isPending}
                  onClick={() => void onDelete("forEveryone")}
                >
                  <Trash2 className="size-4" />
                  {t("inbox.whatsapp.deleteForEveryone")}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <MediaLightbox
        entry={lightbox}
        onClose={() => setLightbox(null)}
        onDownload={(row) => void onDownload(row)}
        downloadPending={download.isPending}
      />
    </div>
  );
}
