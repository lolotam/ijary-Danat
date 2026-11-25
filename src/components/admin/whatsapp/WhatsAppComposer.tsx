import { useRef, useState } from "react";
import { Paperclip, SendHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSendWhatsAppMedia, useSendWhatsAppMessage } from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";

/** Client-side mirror of the server's 10MB chat media ceiling. */
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** What the picker offers; the server accepts any type and files as documents. */
const ACCEPTED_TYPES =
  "image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip";

interface WhatsAppComposerProps {
  chatNumber: string;
  disabled: boolean;
}

/**
 * ملحن الرسائل أسفل الخيط: Enter يرسل و Shift+Enter يضيف سطراً، ومشبك الورق
 * يرسل صورة أو مستنداً أو أي ملف، كما في واتساب ويب.
 *
 * The draft survives a failed send (only a successful one clears the box), so
 * a disconnected-session error never eats what the admin typed.
 */
export function WhatsAppComposer({ chatNumber, disabled }: WhatsAppComposerProps) {
  const { t } = useI18n();
  const send = useSendWhatsAppMessage(chatNumber);
  const sendMedia = useSendWhatsAppMedia(chatNumber);
  const [draft, setDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = send.isPending || sendMedia.isPending;

  async function onSend() {
    const body = draft.trim();
    if (!body || busy) return;
    try {
      await send.mutateAsync(body);
      setDraft("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  async function onFilePicked(file: File | undefined) {
    if (!file || busy) return;
    if (file.size > MEDIA_MAX_BYTES) {
      toast.error(t("inbox.whatsapp.fileTooLarge"));
      return;
    }
    try {
      await sendMedia.mutateAsync(file);
      toast.success(t("inbox.whatsapp.fileSent"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="flex items-end gap-2 border-t bg-background p-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={(event) => {
          void onFilePicked(event.target.files?.[0]);
          // Reset so picking the same file twice re-fires the change event.
          event.target.value = "";
        }}
      />
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => fileInputRef.current?.click()}
        aria-label={t("inbox.whatsapp.attachFile")}
      >
        <Paperclip className={`size-4 ${sendMedia.isPending ? "animate-pulse" : ""}`} />
      </Button>
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void onSend();
          }
        }}
        placeholder={t("inbox.whatsapp.composerPlaceholder")}
        disabled={disabled}
        rows={1}
        className="max-h-32 min-h-10 flex-1 resize-none"
        dir="auto"
      />
      <Button
        size="icon"
        onClick={() => void onSend()}
        disabled={disabled || busy || !draft.trim()}
        aria-label={t("inbox.whatsapp.send")}
      >
        <SendHorizontal className="size-4 rtl:-scale-x-100" />
      </Button>
    </div>
  );
}
