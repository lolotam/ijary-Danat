import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePermissions } from "@/hooks/usePermissions";
import { useContactInquiries, useTenantMessages } from "@/hooks/useTenantMessages";
import { useLeasingInquiries } from "@/hooks/useLandingSettings";
import { useGmailMessages } from "@/hooks/useGmailMessages";
import { useWhatsAppChats } from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";
import type { InboxTab } from "@/lib/inboxSearch";

/** How many entries the dropdown lists before deferring to the inbox itself. */
const DROPDOWN_LIMIT = 8;

interface UnreadEntry {
  id: string;
  tab: InboxTab;
  /** Who it is from — tenant name, lead name, or sender address. */
  who: string;
  /** Subject line, falling back to the body so a subject-less entry is not blank. */
  preview: string;
  receivedAt: string;
  sourceLabel: string;
}

/**
 * Header bell showing the consolidated unread count across all inbox sources:
 * tenant messages, visitor (contact) inquiries, leasing leads, and Gmail.
 * Selecting an entry opens the Admin Inbox on that entry's own tab with its row
 * highlighted.
 *
 * Each source is fetched as a server-side unread page (status/is_read filter +
 * page size). The badge uses the exact total count from each query so unread
 * beyond the dropdown still increments the number; the list shows only the
 * freshest `DROPDOWN_LIMIT` per source before merging.
 */
export function InboxBell() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const enabled = !permissions.isLoading && permissions.isStaff;
  const messages = useTenantMessages({ page: 1, pageSize: DROPDOWN_LIMIT, status: "new" }, enabled);
  const inquiries = useContactInquiries(
    { page: 1, pageSize: DROPDOWN_LIMIT, status: "new" },
    enabled,
  );
  const leads = useLeasingInquiries({ page: 1, pageSize: DROPDOWN_LIMIT, status: "new" }, enabled);
  const gmail = useGmailMessages({ page: 1, pageSize: DROPDOWN_LIMIT, isRead: false }, enabled);
  const whatsappChats = useWhatsAppChats(enabled, "");
  const unreadWhatsappChats = (whatsappChats.data ?? []).filter((chat) => chat.unread_count > 0);

  const entries: UnreadEntry[] = [
    ...(messages.data?.items ?? []).map((message) => ({
      id: message.id,
      tab: "tenants" as const,
      who: message.tenant?.name ?? "—",
      preview: message.subject || message.body,
      receivedAt: message.created_at,
      sourceLabel: t("inbox.tenantMessages"),
    })),
    ...(inquiries.data?.items ?? []).map((inquiry) => ({
      id: inquiry.id,
      tab: "visitors" as const,
      who: inquiry.name,
      preview: inquiry.subject || inquiry.message,
      receivedAt: inquiry.created_at,
      sourceLabel: t("inbox.contactInquiries"),
    })),
    ...(leads.data?.items ?? []).map((lead) => ({
      id: lead.id,
      tab: "leads" as const,
      who: lead.name,
      preview: lead.message || lead.email,
      receivedAt: lead.created_at,
      sourceLabel: t("inbox.leasingLeads"),
    })),
    ...(gmail.data?.items ?? []).map((message) => ({
      id: message.id,
      tab: "gmail" as const,
      who: message.from_address,
      preview: message.subject || message.snippet || "—",
      receivedAt: message.received_at,
      sourceLabel: t("inbox.gmail"),
    })),
    ...unreadWhatsappChats.slice(0, DROPDOWN_LIMIT).map((chat) => ({
      id: chat.chat_number,
      tab: "whatsapp" as const,
      who: chat.display_name || `+${chat.chat_number}`,
      preview: chat.last_message_preview || "—",
      receivedAt: chat.last_message_at ?? chat.updated_at,
      sourceLabel: t("inbox.whatsapp"),
    })),
  ].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  // Exact unread totals (not just the page of rows in the dropdown). WhatsApp
  // counts unread messages across chats, matching the tab badge.
  const unreadTotal =
    (messages.data?.count ?? 0) +
    (inquiries.data?.count ?? 0) +
    (leads.data?.count ?? 0) +
    (gmail.data?.count ?? 0) +
    (whatsappChats.data ?? []).reduce((sum, chat) => sum + chat.unread_count, 0);

  if (!permissions.isStaff) return null;

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0 pointer-coarse:size-11"
          title={t("notifications.inboxBadge")}
          aria-label={t("notifications.inboxBadge")}
        >
          <Bell className="size-4" />
          {unreadTotal > 0 && (
            <span className="absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-4 text-destructive-foreground">
              {unreadTotal}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t("inbox.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {entries.length === 0 ? (
          <DropdownMenuItem disabled className="text-muted-foreground">
            {t("inbox.empty")}
          </DropdownMenuItem>
        ) : (
          entries.slice(0, DROPDOWN_LIMIT).map((entry) => (
            <DropdownMenuItem key={`${entry.tab}-${entry.id}`} asChild>
              <Link
                to="/admin/inbox"
                search={{ tab: entry.tab, message: entry.id }}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{entry.who}</span>
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                    {entry.sourceLabel}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{entry.preview}</span>
                <span className="text-[10px] text-muted-foreground">
                  {dateFormatter.format(new Date(entry.receivedAt))}
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/admin/inbox" search={{}} className="justify-center text-xs font-medium">
            {t("inbox.title")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
