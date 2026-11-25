import { useEffect, useState } from "react";
import { Search, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WhatsappChatRow } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { isAvatarUrlExpired } from "@/lib/whatsappAvatar";

interface WhatsAppChatListProps {
  chats: WhatsappChatRow[];
  isLoading: boolean;
  selectedChat: string | null;
  onSelectChat: (chatNumber: string) => void;
  /** Hover trash action; omitted (undefined) hides it for read-only staff. */
  onDeleteChat?: (chat: WhatsappChatRow) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

/**
 * يعيد الأحرف الأولى لاسم العرض (أو آخر رقمين) لصورة الحرف الرمزية.
 *
 * مشترك بين قائمة المحادثات وترويسة الخيط المفتوح فيبقى الحرف البديل
 * واحدًا في الموضعين بدل اشتقاقين يتباعدان.
 */
export function chatInitials(chat: WhatsappChatRow): string {
  const name = chat.display_name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    return parts
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase();
  }
  return chat.chat_number.slice(-2);
}

/**
 * صورة المحادثة: صورة واتساب الشخصية إن توفرت، وإلا الأحرف الأولى.
 *
 * WhatsApp CDN picture URLs expire, and they say when: `isAvatarUrlExpired`
 * reads the expiry out of the URL so a known-dead link never becomes a
 * request. onError still covers everything the stamp cannot predict (a
 * deleted picture, a blocked contact, an offline CDN). A fresh URL resets the
 * failure so a picture refreshed by a sync (the chat list re-polls every 15s)
 * appears without reopening the inbox.
 */
export function ChatAvatar({
  avatarUrl,
  initials,
  className,
}: {
  avatarUrl: string | null;
  initials: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);
  // A link whose stamped expiry has passed is skipped without requesting it:
  // the CDN answers those with a 403, and the onError round trip below would
  // reach the same initials a moment later after a failed network request.
  if (avatarUrl && !failed && !isAvatarUrlExpired(avatarUrl)) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("size-10 shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary",
        className,
      )}
    >
      {initials}
    </span>
  );
}

/**
 * يعرض وقت آخر رسالة بأسلوب واتساب: وقت اليوم، وإلا التاريخ القصير.
 */
function lastMessageTime(value: string | null, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tag = locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB";
  return sameDay
    ? new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", year: "2-digit" }).format(
        date,
      );
}

/**
 * قائمة المحادثات في الجهة البادئة من صندوق واتساب، بأسلوب واتساب ويب.
 */
export function WhatsAppChatList({
  chats,
  isLoading,
  selectedChat,
  onSelectChat,
  onDeleteChat,
  search,
  onSearchChange,
}: WhatsAppChatListProps) {
  const { t, locale } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-2">
        <div className="relative">
          <Search className="absolute inset-inline-start-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground ltr:left-2 rtl:right-2" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("inbox.whatsapp.searchPlaceholder")}
            className="h-9 ps-8"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : chats.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("inbox.whatsapp.noChats")}</p>
        ) : (
          <ul>
            {chats.map((chat) => (
              <li key={chat.chat_number} className="group relative">
                {onDeleteChat ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute inset-inline-end-1 top-1 z-10 size-7 opacity-0 transition-opacity group-hover:opacity-100 ltr:right-1 rtl:left-1"
                    title={t("inbox.whatsapp.deleteChat")}
                    aria-label={t("inbox.whatsapp.deleteChat")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteChat(chat);
                    }}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelectChat(chat.chat_number)}
                  className={cn(
                    "flex w-full items-center gap-3 border-b px-3 py-2.5 text-start transition-colors hover:bg-muted/60",
                    selectedChat === chat.chat_number && "bg-muted",
                  )}
                >
                  <ChatAvatar avatarUrl={chat.avatar_url} initials={chatInitials(chat)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {chat.display_name || `+${chat.chat_number}`}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground" dir="ltr">
                        {lastMessageTime(chat.last_message_at, locale)}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {chat.last_message_preview ?? ""}
                      </span>
                      {chat.unread_count > 0 ? (
                        <Badge className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px]">
                          {chat.unread_count}
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
