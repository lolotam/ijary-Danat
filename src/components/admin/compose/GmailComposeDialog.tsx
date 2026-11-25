import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";

import { ComposeRecipients } from "@/components/admin/compose/ComposeRecipients";
import { RichTextEditor } from "@/components/admin/compose/RichTextEditor";
import { SignatureManager } from "@/components/admin/compose/SignatureManager";
import { gmailSend, plainTextFrom } from "@/fns/gmailSend";
import { RESEND_SENDER_LIST_CODE, resendMailboxSend } from "@/fns/resendMailboxSend";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import {
  buildMailboxSenders,
  defaultMailboxSender,
  type MailboxSender,
} from "@/lib/mailboxSenders";
import type { MailboxProvider } from "@/hooks/useGmailMessages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import type { EmailSignatureRow } from "@/integrations/supabase/database.types";
import { parseAddresses } from "@/lib/addressList";
import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";
import { applySignatureToBody } from "@/lib/signatureHtml";

/**
 * نافذة الإنشاء، وتُستخدم كذلك للرد والرد على الكل وإعادة التوجيه.
 *
 * The compose window — also used for reply, reply-all and forward, which differ
 * only in their initial values and whether they thread.
 *
 * From is a *choice between legal senders*, not free text. Gmail still refuses
 * an arbitrary sender and sends only as the authenticated account, so it
 * contributes exactly one option; Resend verifies a domain, so every address in
 * the `resend_senders` catalogue is another. Picking the sender therefore picks
 * the provider, which is why there is no separate provider control — a toggle
 * would allow Gmail plus an arbitrary address, and Gmail would reject it.
 *
 * A reply locks to the provider the original arrived on. Gmail threads from
 * headers stored against that message, and a reply re-routed through Resend
 * would join no conversation while looking like it had.
 */

export interface ComposeSeed {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /**
   * Rich-text body, the editor's source of truth.
   *
   * Required rather than optional so the compiler finds every seed site. Left
   * optional, a reply seeded without it would open an empty editor and silently
   * drop the quoted message the admin is replying to.
   */
  html: string;
  /** The `gmail_messages` row this replies to, if any. */
  replyToMessageId?: string;
  /** Forwards seed from a message but must start a new thread. */
  thread: boolean;
}

export const emptyCompose = (): ComposeSeed => ({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  html: "",
  thread: false,
});

/**
 * يحوّل نصًا عاديًا إلى HTML آمن مع الحفاظ على فواصل الأسطر.
 *
 * Reply and forward seeds are built from the parent message's plain text.
 * Handing that straight to the editor would lose every line break — a quoted
 * message collapses into one paragraph — and would let a crafted message body
 * inject markup into the admin's compose window.
 */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(/\r?\n/)
    .map((line) => `<p>${line || "<br>"}</p>`)
    .join("");
}

interface PendingAttachment {
  filename: string;
  mimeType: string;
  /** Base64 without the data-URL prefix. */
  content: string;
  sizeBytes: number;
}

/** Gmail's 25 MB ceiling applies post-encoding; ~18 MB raw is the usable budget. */
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result);
      // FileReader yields a data URL; the server wants bare base64.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function GmailComposeDialog({
  open,
  seed,
  fromAddress,
  lockedProvider,
  onOpenChange,
  onSent,
}: {
  open: boolean;
  seed: ComposeSeed;
  fromAddress: string | null;
  /**
   * Set when replying or forwarding: the provider the original arrived on. The
   * sender is pinned to it so a reply cannot silently leave the thread.
   */
  lockedProvider?: MailboxProvider | null;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}) {
  const { locale, t } = useI18n();
  const send = useServerFn(gmailSend);
  const sendViaResend = useServerFn(resendMailboxSend);
  const fileInput = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<ComposeSeed>(seed);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [showCc, setShowCc] = useState(Boolean(seed.cc || seed.bcc));
  const [sending, setSending] = useState(false);
  const [signature, setSignature] = useState<EmailSignatureRow | null>(null);
  const [senderId, setSenderId] = useState<string | null>(null);

  const gmailConnection = useGmailConnection();
  const resendSenderItems = useOptionListItemsByCode(RESEND_SENDER_LIST_CODE, open);

  const senders = useMemo(
    () =>
      buildMailboxSenders({
        gmailAddress: fromAddress ?? gmailConnection.data?.email_address ?? null,
        // Gmail contributes a sender only when an account is actually connected;
        // offering one otherwise produces a Send button that always fails.
        gmailCanSend: Boolean(fromAddress ?? gmailConnection.data?.email_address),
        resendAddresses: (resendSenderItems.data ?? []).map((item) => ({
          label: locale === "ar" ? item.label_ar : item.label_en,
          value: item.value,
        })),
      }),
    [fromAddress, gmailConnection.data?.email_address, resendSenderItems.data, locale],
  );

  const availableSenders = useMemo(
    () => (lockedProvider ? senders.filter((s) => s.provider === lockedProvider) : senders),
    [senders, lockedProvider],
  );

  const activeSender: MailboxSender | null =
    availableSenders.find((s) => s.id === senderId) ??
    defaultMailboxSender(availableSenders, lockedProvider ?? null);

  // Reseed whenever a different message is replied to or forwarded; without
  // this the dialog keeps the previous message's quoted body.
  useEffect(() => {
    if (!open) return;
    setDraft(seed);
    setAttachments([]);
    setShowCc(Boolean(seed.cc || seed.bcc));
    // The reseeded body carries no signature, so a selection left over from the
    // previous message would show one picked while none is in the message —
    // and, now that submit() no longer appends, it would send without one.
    setSignature(null);
  }, [open, seed]);

  /**
   * يدرج التوقيع المختار في نص الرسالة مباشرةً بدل إلحاقه عند الإرسال.
   *
   * The body is the source of truth from here on: `applySignatureToBody` strips
   * whatever block is present before adding the new one, so picking a second
   * signature swaps it and picking none removes it.
   */
  function selectSignature(next: EmailSignatureRow | null) {
    setSignature(next);
    setDraft((current) => ({
      ...current,
      html: applySignatureToBody(current.html, sanitizeSignatureHtml(next?.content_html ?? "")),
    }));
  }

  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const incoming: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      incoming.push({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        content: await readAsBase64(file),
        sizeBytes: file.size,
      });
    }
    const combined = [...attachments, ...incoming];
    if (combined.reduce((sum, a) => sum + a.sizeBytes, 0) > MAX_TOTAL_BYTES) {
      toast.error(t("inbox.attachmentsTooLarge"));
      return;
    }
    setAttachments(combined);
  }

  async function submit() {
    const to = parseAddresses(draft.to);
    const cc = parseAddresses(draft.cc);
    const bcc = parseAddresses(draft.bcc);
    // Bcc alone is a valid send — it is what addressing every tenant produces.
    if (!to.length && !cc.length && !bcc.length) {
      toast.error(t("inbox.recipientRequired"));
      return;
    }
    // An empty TipTap document is "<p></p>", which is truthy. Guarding on the
    // raw HTML would enable Send on a blank message.
    const bodyText = plainTextFrom(draft.html);
    if (!draft.subject.trim() && !bodyText.trim()) {
      toast.error(t("inbox.subjectOrBodyRequired"));
      return;
    }

    // The body already contains the signature: it was injected when the admin
    // picked one, so appending here would send it twice.
    const html = draft.html;

    if (!activeSender) {
      toast.error(t("compose.senderNone"));
      return;
    }

    const payloadAttachments = attachments.map(({ filename, mimeType, content }) => ({
      filename,
      mimeType,
      content,
    }));

    setSending(true);
    try {
      if (activeSender.provider === "resend") {
        // No `replyToMessageId` or `thread`: Resend has no thread to join, and
        // the sender is locked to Gmail whenever the original arrived there, so
        // this branch is only ever reached for a genuinely new message.
        await sendViaResend({
          data: {
            from: activeSender.address,
            to,
            cc,
            bcc,
            subject: draft.subject,
            body: plainTextFrom(html),
            html,
            attachments: payloadAttachments,
          },
        });
      } else {
        await send({
          data: {
            to,
            cc,
            bcc,
            subject: draft.subject,
            // Both parts: a text-only client handed nothing renders blank.
            body: plainTextFrom(html),
            html,
            attachments: payloadAttachments,
            replyToMessageId: draft.replyToMessageId,
            thread: draft.thread,
          },
        });
      }
      toast.success(t("inbox.messageSent"));
      onOpenChange(false);
      onSent?.();
    } catch (error) {
      // The send path turns Google's scope and auth failures into an
      // instruction ("reconnect Gmail"), so the raw message is the useful one.
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Centred by `inset-0` + `m-auto` rather than by the base DialogContent's
        `left-1/2 top-1/2 translate-x-[-50%] translate-y-[-50%]`.

        That transform is what every other dialog here relies on, and it works
        for them — they all size with `max-h-*` and inherit `w-full`. This one
        is the only dialog with a *definite* height and width, and with both
        set the translate left it anchored by its top-left corner at the page
        centre, so a 92vh × 96vw window hung off the bottom-right of the screen.

        Zeroing the translates and letting auto margins do the centring is the
        same approach the app's other large dialog already takes (the mobile
        full-screen one in Phase2Ui). With `position: fixed`, `inset: 0` and a
        definite width and height, `margin: auto` centres on both axes — and it
        cannot be defeated by a transform, because it does not use one. The
        open/close zoom animation still scales about the element's own centre.
      */}
      <DialogContent className="fixed inset-0 m-auto flex h-[92vh] w-[96vw] max-w-5xl translate-x-0 translate-y-0 flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle>{t("inbox.compose")}</DialogTitle>
          <DialogDescription className="sr-only">{t("inbox.composeSubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="compose-sender">
              {t("compose.sender")}
            </Label>
            {availableSenders.length === 0 ? (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <LtrText>{t("compose.senderNone")}</LtrText>
              </div>
            ) : (
              <Select
                value={activeSender?.id ?? undefined}
                onValueChange={setSenderId}
                disabled={availableSenders.length === 1}
              >
                <SelectTrigger id="compose-sender">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableSenders.map((sender) => (
                    <SelectItem key={sender.id} value={sender.id}>
                      {t(
                        sender.provider === "resend"
                          ? "compose.senderResend"
                          : "compose.senderGmail",
                        // The catalogue's name when it has one ("Management"),
                        // because that is what the admin recognises; the bare
                        // address otherwise.
                      ).replace(
                        "{address}",
                        sender.label ? `${sender.label} <${sender.address}>` : sender.address,
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {lockedProvider ? (
              <p className="text-xs text-muted-foreground">{t("compose.senderLockedReply")}</p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label required htmlFor="compose-to" className="text-xs text-muted-foreground">
                {t("inbox.to")}
              </Label>
              <div className="flex items-center gap-1">
                <ComposeRecipients
                  to={draft.to}
                  bcc={draft.bcc}
                  onChange={(next) => {
                    setDraft((current) => ({ ...current, ...next }));
                    // Reveal Bcc when the picker fills it, or the addresses are
                    // invisible and the admin cannot tell who is on the message.
                    if (next.bcc.trim()) setShowCc(true);
                  }}
                />
                {!showCc && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => setShowCc(true)}
                  >
                    {t("inbox.addCcBcc")}
                  </Button>
                )}
              </div>
            </div>
            <Input
              id="compose-to"
              dir="ltr"
              value={draft.to}
              placeholder="name@example.com, another@example.com"
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>

          {showCc && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="compose-cc" className="text-xs text-muted-foreground">
                  {t("inbox.cc")}
                </Label>
                <Input
                  id="compose-cc"
                  dir="ltr"
                  value={draft.cc}
                  onChange={(e) => setDraft({ ...draft, cc: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="compose-bcc" className="text-xs text-muted-foreground">
                  {t("inbox.bcc")}
                </Label>
                <Input
                  id="compose-bcc"
                  dir="ltr"
                  value={draft.bcc}
                  onChange={(e) => setDraft({ ...draft, bcc: e.target.value })}
                />
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="compose-subject" className="text-xs text-muted-foreground">
              {t("inbox.subject")}
            </Label>
            <Input
              id="compose-subject"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </div>

          <RichTextEditor
            value={draft.html}
            onChange={(html) => setDraft((current) => ({ ...current, html }))}
            placeholder={t("inbox.bodyPlaceholder")}
          />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <span
                  key={`${attachment.filename}-${index}`}
                  className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1 text-xs"
                >
                  <Paperclip className="size-3" />
                  <span className="max-w-[220px] truncate">{attachment.filename}</span>
                  <span className="text-muted-foreground">
                    {(attachment.sizeBytes / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={() =>
                      setAttachments((prev) => prev.filter((_, position) => position !== index))
                    }
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t px-5 py-3">
          <Button onClick={submit} disabled={sending}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {t("inbox.send")}
          </Button>
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={sending}>
            <Paperclip className="size-4" />
            {t("inbox.attach")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {totalBytes > 0 && (
            <span className="text-xs text-muted-foreground">
              {(totalBytes / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          <div className="ms-auto flex items-center gap-2">
            {/*
              Selecting a signature injects it into the body, so the admin sees
              what will be sent and can edit or delete it. submit() no longer
              appends anything — that would send it twice — and the injection
              replaces any block already there rather than stacking a second.
            */}
            <SignatureManager selectedId={signature?.id ?? null} onSelect={selectSignature} />
          </div>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            {t("common.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
