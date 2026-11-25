import { Mail, MailOpen, Trash2 } from "lucide-react";

import { MailboxProviderBadge } from "@/components/admin/inbox/MailboxProviderBadge";
import { TableState } from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listItemDeliveryFailure, type GmailMessageListItem } from "@/hooks/useGmailMessages";
import { highlightFailedRecipients } from "@/lib/gmailDeliveryFailure";

/**
 * جدول رسائل Gmail المشترك لتابي الوارد والمرسل، بما فيها شارة فشل التسليم.
 *
 * Extracted so both folders keep identical row actions (open, mark read/unread,
 * category display, trash, bulk select). Duplicating this table would mean the
 * next action change lands on one folder and is missed on the other.
 */
export function GmailMessagesTable(props: {
  rows: GmailMessageListItem[];
  highlightId?: string;
  selectedIds: Set<string>;
  loading: boolean;
  error: boolean;
  dateFormatter: Intl.DateTimeFormat;
  categoryLabel: (value: string | null) => string | null;
  markReadPending: boolean;
  onToggleId: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (id: string, isRead: boolean) => void;
  onToggleRead: (id: string, isRead: boolean) => void;
  /** غائب لمن لا يملك inbox.manage، فيُخفى زر الحذف. */
  onDelete?: (id: string) => void;
  t: (key: string) => string;
}) {
  const {
    rows,
    highlightId,
    selectedIds,
    loading,
    error,
    dateFormatter,
    categoryLabel,
    markReadPending,
    onToggleId,
    onToggleAll,
    onOpen,
    onToggleRead,
    onDelete,
    t,
  } = props;

  return (
    <TableState loading={loading} error={error} empty={!rows.length}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={rows.length > 0 && rows.every((g) => selectedIds.has(g.id))}
                onCheckedChange={onToggleAll}
                aria-label={t("common.select")}
              />
            </TableHead>
            <TableHead className="w-12">#</TableHead>
            <TableHead>{t("audit.createdAt")}</TableHead>
            <TableHead>{t("common.name")}</TableHead>
            <TableHead>{t("portal.messages.subject")}</TableHead>
            <TableHead>{t("portal.messages.body")}</TableHead>
            <TableHead>{t("inbox.category")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((message, index) => {
            const bounce = listItemDeliveryFailure(message);
            return (
              <TableRow
                key={message.id}
                id={`gmail-${message.id}`}
                className={
                  message.id === highlightId
                    ? "bg-primary/10"
                    : bounce.isDeliveryFailure
                      ? "bg-destructive/5"
                      : !message.is_read
                        ? "bg-accent/10"
                        : ""
                }
              >
                <TableCell>
                  <Checkbox
                    checked={selectedIds.has(message.id)}
                    onCheckedChange={() => onToggleId(message.id)}
                    aria-label={t("common.select")}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {dateFormatter.format(new Date(message.received_at))}
                </TableCell>
                <TableCell className="font-medium">
                  <div className="flex flex-wrap items-center gap-1">
                    <Mail className="size-3 text-muted-foreground" />
                    {message.from_address}
                    <MailboxProviderBadge provider={message.provider} />
                    {bounce.isDeliveryFailure && (
                      <Badge variant="destructive">{t("inbox.deliveryFailure")}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="text-start font-medium underline-offset-2 hover:underline"
                    onClick={() => onOpen(message.id, message.is_read)}
                  >
                    {message.subject || t("inbox.noSubject")}
                  </button>
                </TableCell>
                <TableCell className="max-w-md whitespace-pre-wrap text-sm">
                  {bounce.isDeliveryFailure && bounce.failedRecipients.length
                    ? highlightFailedRecipients(message.snippet ?? "", bounce.failedRecipients).map(
                        (part, partIndex) =>
                          part.failed ? (
                            <mark
                              key={`${message.id}-${partIndex}`}
                              className="rounded bg-destructive/20 px-0.5 font-medium text-destructive"
                            >
                              {part.text}
                            </mark>
                          ) : (
                            <span key={`${message.id}-${partIndex}`}>{part.text}</span>
                          ),
                      )
                    : (message.snippet ?? "—")}
                </TableCell>
                <TableCell>
                  {message.category ? (
                    <Badge variant="secondary">{categoryLabel(message.category)}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="pointer-coarse:min-h-11"
                      onClick={() => onOpen(message.id, message.is_read)}
                    >
                      <MailOpen className="size-4" />
                      {t("inbox.open")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="pointer-coarse:min-h-11"
                      disabled={markReadPending}
                      onClick={() => onToggleRead(message.id, !message.is_read)}
                    >
                      {message.is_read ? (
                        <Mail className="size-4" />
                      ) : (
                        <MailOpen className="size-4" />
                      )}
                      {message.is_read ? t("inbox.markUnread") : t("inbox.markRead")}
                    </Button>
                    {onDelete && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive pointer-coarse:size-11"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={() => onDelete(message.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableState>
  );
}
