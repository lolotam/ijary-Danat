import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Download, Forward, Loader2, Reply, ReplyAll } from "lucide-react";
import { toast } from "sonner";

import { GmailMessageBody } from "@/components/admin/GmailMessageBody";
import { plainTextToHtml, type ComposeSeed } from "@/components/admin/compose/GmailComposeDialog";
import { gmailAttachment } from "@/fns/gmailAttachment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  detectGmailDeliveryFailure,
  useGmailMessage,
  useSetGmailCategory,
} from "@/hooks/useGmailMessages";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { MailboxProviderBadge } from "@/components/admin/inbox/MailboxProviderBadge";
import { useI18n } from "@/i18n/provider";
import {
  buildReplyRecipients,
  extractHeaders,
  extractHtmlBody,
  extractPlainText,
  forwardPreamble,
  forwardSubject,
  listAttachments,
  quoteForReply,
  replySubject,
  type GmailMessagePayload,
} from "@/lib/gmailMessage";

/**
 * يقرأ رسالة واحدة: النص الكامل، المرفقات، التصنيف، وإجراءات الرد وإعادة التوجيه.
 *
 * Everything shown here is parsed out of `raw_payload`, which already holds the
 * complete `format=full` message. The only thing Gmail is asked for again is
 * attachment *bytes*, which `format=full` omits.
 */

/** The category value meaning "none", since Radix Select rejects an empty one. */
const NO_CATEGORY = "__none__";

function triggerDownload(base64Url: string, filename: string, mimeType: string) {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function GmailMessageSheet({
  messageId,
  connectedAddress,
  onOpenChange,
  onCompose,
}: {
  messageId: string | null;
  connectedAddress: string | null;
  onOpenChange: (open: boolean) => void;
  onCompose: (seed: ComposeSeed) => void;
}) {
  const { t, locale } = useI18n();
  const message = useGmailMessage(messageId);
  const setCategory = useSetGmailCategory();
  const categories = useOptionListItemsByCode("gmail_categories");
  const downloadAttachment = useServerFn(gmailAttachment);
  const [downloading, setDownloading] = useState<string | null>(null);

  const parsed = useMemo(() => {
    const payload = (message.data?.raw_payload as { payload?: unknown } | null)?.payload as
      | GmailMessagePayload
      | undefined;
    return {
      headers: extractHeaders(payload),
      html: extractHtmlBody(payload),
      text: extractPlainText(payload) ?? message.data?.body_text ?? null,
      attachments: listAttachments(payload),
      deliveryFailure: detectGmailDeliveryFailure({
        fromAddress: message.data?.from_address,
        snippet: message.data?.snippet,
        headers: payload?.headers,
      }),
    };
  }, [message.data]);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(parsed.text ?? "");
      toast.success(t("inbox.copied"));
    } catch (error) {
      console.error("[mailbox-copy] failed:", error);
      toast.error(t("common.error"));
    }
  }

  async function download(attachmentId: string) {
    if (!messageId) return;
    setDownloading(attachmentId);
    try {
      const result = await downloadAttachment({ data: { messageId, attachmentId } });
      triggerDownload(result.data, result.filename, result.mimeType);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setDownloading(null);
    }
  }

  /**
   * Reply-all keeps everyone except this mailbox — otherwise every reply mails
   * the account it was sent from, which the sync worker then pulls straight back
   * in as a new message.
   *
   * That exclusion needs to know which address is ours, and `connectedAddress`
   * arrives from a query that has not resolved on the first render. Comparing
   * against an undefined address silently matches nothing, so the guard has to
   * be an explicit early return rather than an optional-chained comparison —
   * the failure mode is a self-addressed reply, not an error.
   */
  const canReplyAll = Boolean(connectedAddress);

  function startReply(all: boolean) {
    if (!messageId) return;
    const recipients = buildReplyRecipients(parsed.headers, connectedAddress, all);
    onCompose({
      to: recipients.to.join(", "),
      cc: recipients.cc.join(", "),
      bcc: "",
      subject: replySubject(parsed.headers.subject),
      html: plainTextToHtml(quoteForReply(parsed.headers, parsed.text)),
      replyToMessageId: messageId,
      thread: true,
    });
  }

  function startForward() {
    onCompose({
      to: "",
      cc: "",
      bcc: "",
      subject: forwardSubject(parsed.headers.subject),
      html: plainTextToHtml(forwardPreamble(parsed.headers) + (parsed.text ?? "")),
      // A forward starts its own conversation; threading it onto the original
      // would drop it into a thread the new recipient was never part of.
      thread: false,
    });
  }

  return (
    <Sheet open={Boolean(messageId)} onOpenChange={onOpenChange}>
      <SheetContent side={locale === "ar" ? "left" : "right"} className="w-full sm:max-w-2xl">
        {message.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : !message.data ? (
          <p className="p-4 text-sm text-muted-foreground">{t("common.error")}</p>
        ) : (
          <div className="flex h-full flex-col gap-4 overflow-y-auto">
            <SheetHeader className="space-y-2 text-start">
              <SheetTitle className="text-base leading-snug">
                {message.data.subject || t("inbox.noSubject")}
              </SheetTitle>
              <SheetDescription className="sr-only">{t("inbox.messageBody")}</SheetDescription>
              {parsed.deliveryFailure.isDeliveryFailure && (
                <div
                  role="status"
                  className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
                >
                  <Badge variant="destructive">{t("inbox.deliveryFailure")}</Badge>
                  {parsed.deliveryFailure.failedRecipients.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {parsed.deliveryFailure.failedRecipients.map((address) => (
                        <li key={address.toLowerCase()}>
                          <span className="text-muted-foreground">
                            {t("inbox.failedRecipient")}:{" "}
                          </span>
                          <LtrText className="font-semibold text-destructive">{address}</LtrText>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="font-medium">{t("inbox.from")}: </span>
                  <LtrText>{message.data.from_address}</LtrText>
                  {/*
                    Also shown here, not only in the list row: provenance decides
                    what the reader can do next — a Resend message cannot be
                    trashed at the provider and a reply leaves through Resend —
                    and the badge vanishing on open is exactly when that matters.
                  */}
                  <MailboxProviderBadge provider={message.data.provider} />
                </div>
                {message.data.to_address && (
                  <div>
                    <span className="font-medium">{t("inbox.to")}: </span>
                    <LtrText>{message.data.to_address}</LtrText>
                  </div>
                )}
                {parsed.headers.cc && (
                  <div>
                    <span className="font-medium">{t("inbox.cc")}: </span>
                    <LtrText>{parsed.headers.cc}</LtrText>
                  </div>
                )}
                <FormattedDate value={message.data.received_at} />
              </div>
            </SheetHeader>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => startReply(false)}>
                <Reply className="size-4" /> {t("inbox.reply")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canReplyAll}
                title={canReplyAll ? undefined : t("inbox.notConnected")}
                onClick={() => startReply(true)}
              >
                <ReplyAll className="size-4" /> {t("inbox.replyAll")}
              </Button>
              <Button size="sm" variant="outline" onClick={startForward}>
                <Forward className="size-4" /> {t("inbox.forward")}
              </Button>
              <Button size="sm" variant="outline" onClick={copyBody}>
                <Copy className="size-4" /> {t("inbox.copy")}
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("inbox.category")}</span>
              <Select
                value={message.data.category ?? NO_CATEGORY}
                onValueChange={(value) =>
                  setCategory.mutate({
                    id: message.data!.id,
                    category: value === NO_CATEGORY ? null : value,
                  })
                }
              >
                <SelectTrigger className="h-8 w-56">
                  <SelectValue placeholder={t("inbox.uncategorised")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY}>{t("inbox.uncategorised")}</SelectItem>
                  {(categories.data ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.value}>
                      {locale === "ar" ? item.label_ar : item.label_en}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {parsed.attachments.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("inbox.attachments")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {parsed.attachments.map((attachment) => (
                    <Button
                      key={attachment.attachmentId}
                      size="sm"
                      variant="outline"
                      disabled={downloading === attachment.attachmentId}
                      onClick={() => download(attachment.attachmentId)}
                    >
                      {downloading === attachment.attachmentId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      <span className="max-w-[200px] truncate">{attachment.filename}</span>
                      <Badge variant="secondary" className="ms-1">
                        {(attachment.sizeBytes / 1024).toFixed(0)} KB
                      </Badge>
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <GmailMessageBody html={parsed.html} text={parsed.text} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
