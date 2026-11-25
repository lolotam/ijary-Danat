import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LtrText } from "@/components/ui/ltr-text";
import {
  useForwardWhatsAppMessage,
  useWhatsAppChats,
  useWhatsAppContacts,
} from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";

interface WhatsAppForwardDialogProps {
  /** Message being forwarded; null keeps the dialog closed. */
  messageId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * حوار إعادة التوجيه: يجمع المحادثات وجهات الاتصال في قائمة واحدة قابلة
 * للبحث، واختيار وجهة يرسل فوراً — كما في واتساب ويب.
 */
export function WhatsAppForwardDialog({ messageId, onOpenChange }: WhatsAppForwardDialogProps) {
  const { t } = useI18n();
  const open = messageId !== null;
  const [search, setSearch] = useState("");
  const chats = useWhatsAppChats(open, search);
  const contacts = useWhatsAppContacts(open, search);
  const forward = useForwardWhatsAppMessage();

  // Chats first (most recent conversations), then contacts not already listed.
  const chatNumbers = new Set((chats.data ?? []).map((chat) => chat.chat_number));
  const targets = [
    ...(chats.data ?? []).map((chat) => ({
      number: chat.chat_number,
      label: chat.display_name || `+${chat.chat_number}`,
    })),
    ...(contacts.data ?? [])
      .filter((contact) => !chatNumbers.has(contact.phone))
      .map((contact) => ({
        number: contact.phone,
        label: contact.name || `+${contact.phone}`,
      })),
  ];

  async function onPick(number: string) {
    if (!messageId || forward.isPending) return;
    try {
      await forward.mutateAsync({ messageId, toChatNumber: number });
      toast.success(t("inbox.whatsapp.forwarded"));
      setSearch("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("inbox.whatsapp.forwardTitle")}</DialogTitle>
          <DialogDescription>{t("inbox.whatsapp.forwardHint")}</DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("inbox.whatsapp.searchPlaceholder")}
        />
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {targets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("inbox.whatsapp.noChats")}</p>
          ) : (
            <ul>
              {targets.map((target) => (
                <li key={target.number}>
                  <Button
                    variant="ghost"
                    disabled={forward.isPending}
                    onClick={() => void onPick(target.number)}
                    className="h-auto w-full justify-between rounded-none border-b px-3 py-2.5"
                  >
                    <span className="min-w-0 text-start">
                      <span className="block truncate text-sm font-medium">{target.label}</span>
                      <LtrText className="text-xs text-muted-foreground">{`+${target.number}`}</LtrText>
                    </span>
                    <Send className="size-4 shrink-0 rtl:-scale-x-100" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
