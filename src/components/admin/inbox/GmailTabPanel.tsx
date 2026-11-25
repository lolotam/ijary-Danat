import { Mail, MailOpen, PenSquare, RefreshCw, Trash2 } from "lucide-react";

import { GmailComposeDialog } from "@/components/admin/compose/GmailComposeDialog";
import { GmailMessageSheet } from "@/components/admin/GmailMessageSheet";
import { DeleteConfirmation, Pager } from "@/components/admin/Phase2Ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/provider";
import { GmailMessagesTable } from "@/components/admin/inbox/GmailMessagesTable";
import {
  ALL_CATEGORIES,
  ALL_PROVIDERS,
  type GmailInbox,
} from "@/components/admin/inbox/useGmailInbox";

/**
 * لوحة تبويب Gmail: الفلاتر، المزامنة، الكتابة، الإجراءات الجماعية، والمجلدان.
 *
 * Presentational only. Every piece of state it shows comes from
 * `useGmailInbox`, which the inbox page calls so that state survives Radix
 * unmounting this tab when another one is selected.
 */
export function GmailTabPanel({
  gmail,
  canDelete,
  highlightId,
  dateFormatter,
}: {
  gmail: GmailInbox;
  /** inbox.manage — moving messages to Gmail Trash. */
  canDelete: boolean;
  highlightId: string | undefined;
  dateFormatter: Intl.DateTimeFormat;
}) {
  const { t, locale } = useI18n();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t("inbox.gmail")}</CardTitle>
          <CardDescription>{t("inbox.subtitle")}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={gmail.provider} onValueChange={gmail.changeProvider}>
            <SelectTrigger className="h-9 w-40" aria-label={t("inbox.providerFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROVIDERS}>{t("inbox.providerAll")}</SelectItem>
              <SelectItem value="gmail">{t("inbox.providerGmail")}</SelectItem>
              <SelectItem value="resend">{t("inbox.providerResend")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={gmail.category} onValueChange={gmail.changeCategory}>
            <SelectTrigger className="h-9 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>{t("inbox.allCategories")}</SelectItem>
              {(gmail.categories.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.value}>
                  {locale === "ar" ? item.label_ar : item.label_en}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={gmail.runSync.isPending || !gmail.connection.data}
            title={gmail.connection.data ? t("inbox.gmailSync") : t("inbox.notConnected")}
            onClick={() => void gmail.sync()}
          >
            <RefreshCw className={`size-4 ${gmail.runSync.isPending ? "animate-spin" : ""}`} />
            {t("inbox.gmailSync")}
          </Button>
          <Button size="sm" onClick={gmail.composeNew}>
            <PenSquare className="size-4" />
            {t("inbox.compose")}
          </Button>
          {gmail.selectedIds.size > 0 ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={gmail.markRead.isPending}
                onClick={() => void gmail.markSelectedRead(true)}
              >
                <MailOpen className="size-4" />
                {t("inbox.markRead")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={gmail.markRead.isPending}
                onClick={() => void gmail.markSelectedRead(false)}
              >
                <Mail className="size-4" />
                {t("inbox.markUnread")}
              </Button>
              {canDelete && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => gmail.setDeleteIds([...gmail.selectedIds])}
                >
                  <Trash2 className="size-4" />
                  {t("inbox.deleteSelected")}
                </Button>
              )}
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-0 pt-2">
        {/* Nested Received / Sent — same table component, no duplicated row actions. */}
        <Tabs value={gmail.folder} onValueChange={gmail.changeFolder} className="px-4">
          <TabsList>
            <TabsTrigger value="received" className="relative">
              {t("inbox.gmailReceived")}
              {gmail.unreadReceivedCount > 0 && (
                <span className="ms-2 rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                  {gmail.unreadReceivedCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="sent">{t("inbox.gmailSent")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <GmailMessagesTable
          rows={gmail.messages.data?.items ?? []}
          highlightId={highlightId}
          selectedIds={gmail.selectedIds}
          loading={gmail.messages.isLoading}
          error={Boolean(gmail.messages.error)}
          dateFormatter={dateFormatter}
          categoryLabel={gmail.categoryLabel}
          markReadPending={gmail.markRead.isPending}
          onToggleId={gmail.toggleId}
          onToggleAll={gmail.toggleAll}
          onOpen={gmail.open}
          onToggleRead={gmail.toggleRead}
          onDelete={canDelete ? (id) => gmail.setDeleteIds([id]) : undefined}
          t={t}
        />
        <div className="px-4 pb-4">
          <Pager
            page={gmail.page}
            pageSize={gmail.pageSize}
            count={gmail.messages.data?.count ?? 0}
            setPage={gmail.setPage}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * نوافذ تبويب Gmail التي تبقى خارج التبويبات: قارئ الرسالة، الكتابة، وتأكيد الحذف.
 *
 * Rendered by the page outside `<Tabs>`, where they always were, so an open
 * message or a compose window is not torn down by a tab switch.
 */
export function GmailOverlays({ gmail }: { gmail: GmailInbox }) {
  const { t } = useI18n();
  return (
    <>
      <GmailMessageSheet
        messageId={gmail.openId}
        connectedAddress={gmail.connection.data?.email_address ?? null}
        onOpenChange={(next) => !next && gmail.closeMessage()}
        onCompose={gmail.composeFromOpen}
      />

      <GmailComposeDialog
        open={gmail.composeOpen}
        seed={gmail.composeSeed}
        fromAddress={gmail.connection.data?.email_address ?? null}
        lockedProvider={gmail.composeLockedProvider}
        onOpenChange={gmail.setComposeOpen}
      />

      <DeleteConfirmation
        open={Boolean(gmail.deleteIds?.length)}
        pending={gmail.trash.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.bulkDeleteDescription")}
        close={() => gmail.setDeleteIds(null)}
        confirm={gmail.confirmDelete}
      />
    </>
  );
}
