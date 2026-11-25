import { Link } from "@tanstack/react-router";
import { MailOpen, Paperclip, Trash2 } from "lucide-react";

import { Pager, TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, type SortState } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TenantMessageWithTenant } from "@/hooks/useTenantMessages";
import { useI18n } from "@/i18n/provider";

/**
 * جدول رسائل المستأجرين في صندوق الوارد.
 *
 * Extracted from admin.inbox.tsx, which was 1249 lines. Behaviour is unchanged.
 */
export function TenantMessagesTable({
  selectedTenantIds,
  setDeleteTenantIds,
  messagesLoading,
  messagesError,
  sortedMessages,
  allTenantSelected,
  toggleAllTenants,
  toggleTenantId,
  sort,
  toggle,
  highlightId,
  dateFormatter,
  openAttachment,
  markRead,
  markReadPending,
  tenantPage,
  setTenantPage,
  inboxPageSize,
  messagesCount,
}: {
  selectedTenantIds: Set<string>;
  setDeleteTenantIds: (ids: string[]) => void;
  messagesLoading: boolean;
  messagesError: boolean;
  sortedMessages: TenantMessageWithTenant[];
  allTenantSelected: boolean;
  toggleAllTenants: () => void;
  toggleTenantId: (id: string) => void;
  sort: SortState;
  toggle: (key: string) => void;
  highlightId?: string;
  dateFormatter: Intl.DateTimeFormat;
  openAttachment: (path: string) => void;
  markRead: (id: string) => void;
  markReadPending: boolean;
  tenantPage: number;
  setTenantPage: (page: number) => void;
  inboxPageSize: number;
  messagesCount: number;
}) {
  const { t } = useI18n();

  return (
    <Card>
      {selectedTenantIds.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {t("inbox.selectedCount").replace("{{count}}", String(selectedTenantIds.size))}
          </p>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteTenantIds([...selectedTenantIds])}
          >
            <Trash2 className="size-4" />
            {t("inbox.deleteSelected")}
          </Button>
        </div>
      ) : null}
      <CardContent className="p-0">
        <TableState loading={messagesLoading} error={messagesError} empty={!sortedMessages.length}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allTenantSelected}
                    onCheckedChange={toggleAllTenants}
                    aria-label={t("common.select")}
                  />
                </TableHead>
                <TableHead className="w-12">#</TableHead>
                <SortableHead sortKey="created_at" sort={sort} toggle={toggle}>
                  {t("audit.createdAt")}
                </SortableHead>
                <SortableHead sortKey="tenant" sort={sort} toggle={toggle}>
                  {t("contracts.tenant")}
                </SortableHead>
                <SortableHead sortKey="subject" sort={sort} toggle={toggle}>
                  {t("portal.messages.subject")}
                </SortableHead>
                <TableHead>{t("portal.messages.body")}</TableHead>
                <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                  {t("common.status")}
                </SortableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedMessages.map((message, index) => (
                <TableRow
                  key={message.id}
                  id={`message-${message.id}`}
                  className={
                    message.id === highlightId
                      ? "bg-primary/10"
                      : message.status === "new"
                        ? "bg-accent/10"
                        : ""
                  }
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedTenantIds.has(message.id)}
                      onCheckedChange={() => toggleTenantId(message.id)}
                      aria-label={t("common.select")}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {dateFormatter.format(new Date(message.created_at))}
                  </TableCell>
                  <TableCell>
                    {message.tenant ? (
                      <Link
                        to="/admin/tenants/$id"
                        params={{ id: message.tenant.id }}
                        className="text-primary underline"
                      >
                        {message.tenant.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{message.subject ?? "—"}</TableCell>
                  <TableCell className="max-w-md whitespace-pre-wrap text-sm">
                    {message.body}
                  </TableCell>
                  <TableCell>
                    <Badge variant={message.status === "new" ? "destructive" : "secondary"}>
                      {message.status === "new" ? t("inbox.new") : message.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {message.attachment_path && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="pointer-coarse:min-h-11"
                          onClick={() => openAttachment(message.attachment_path!)}
                        >
                          <Paperclip className="size-4" />
                          {t("inbox.attachment")}
                        </Button>
                      )}
                      {message.status === "new" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="pointer-coarse:min-h-11"
                          disabled={markReadPending}
                          onClick={() => markRead(message.id)}
                        >
                          <MailOpen className="size-4" />
                          {t("inbox.markRead")}
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive pointer-coarse:size-11"
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        onClick={() => setDeleteTenantIds([message.id])}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableState>
        <Pager
          page={tenantPage}
          pageSize={inboxPageSize}
          count={messagesCount}
          setPage={setTenantPage}
        />
      </CardContent>
    </Card>
  );
}
