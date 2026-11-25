/**
 * Reading a Gmail message out of the payload we already store.
 *
 * `gmail_messages.raw_payload` holds the whole `format=full` message, so the
 * HTML body, every header, and the attachment manifest are already in the
 * database — no extra column and no re-sync. Everything here is a pure function
 * over that payload so it can be unit-tested without a network or a database,
 * and so it is safe to import from browser code (nothing here touches the
 * server-only Supabase client).
 */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePayload {
  headers?: GmailHeader[];
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePayload[];
}

/** The shape stored in `gmail_messages.raw_payload`. */
export interface GmailRawMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailMessagePayload;
  internalDate?: string;
}

/**
 * Gmail encodes part bodies as URL-safe base64, and this runs in both the
 * browser and the Nitro server, which have no decoder in common. Padding is
 * restored first: Gmail omits it, and `atob` rejects an unpadded string where
 * `Buffer` tolerates it.
 */
export function decodeBody(data: string | undefined): string | null {
  if (!data) return null;
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(padded, "base64").toString("utf8");
    // atob yields one character per byte; TextDecoder is what turns those bytes
    // back into UTF-8 text. Skipping it mangles every non-Latin subject and
    // body, which for this deployment means all the Arabic mail.
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function headerValue(payload: GmailMessagePayload | undefined, name: string): string | null {
  const header = payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

/**
 * Extracts a readable plain-text body.
 *
 * Real mail is multipart: the text lives in `payload.parts[]`, often nested two
 * or three levels deep (multipart/mixed → multipart/alternative → text/plain).
 * `text/plain` wins wherever it appears; `text/html` is the fallback, stripped.
 * Returns null when neither exists and the caller falls back to the snippet.
 */
export function extractPlainText(payload: GmailMessagePayload | undefined): string | null {
  if (!payload) return null;

  let html: string | null = null;

  const walk = (node: GmailMessagePayload): string | null => {
    const mime = node.mimeType?.toLowerCase() ?? "";
    if (mime.startsWith("text/plain")) {
      const text = decodeBody(node.body?.data);
      if (text?.trim()) return text;
    }
    if (mime.startsWith("text/html") && html === null) {
      const raw = decodeBody(node.body?.data);
      if (raw?.trim()) html = stripHtml(raw);
    }
    for (const part of node.parts ?? []) {
      const found = walk(part);
      if (found) return found;
    }
    return null;
  };

  const plain = walk(payload);
  if (plain) return plain;
  if (html) return html;

  // Single-part message with no mimeType declared.
  return decodeBody(payload.body?.data);
}

/**
 * The HTML body, unmodified.
 *
 * Deliberately returns the sender's raw markup rather than something cleaned:
 * the caller renders it inside a sandboxed iframe that cannot execute scripts,
 * which is a stronger guarantee than any string-level scrub. Sanitising here
 * would invite the belief that the output is safe to inject directly, which it
 * is not and never will be.
 */
export function extractHtmlBody(payload: GmailMessagePayload | undefined): string | null {
  if (!payload) return null;

  const walk = (node: GmailMessagePayload): string | null => {
    if (node.mimeType?.toLowerCase().startsWith("text/html")) {
      const html = decodeBody(node.body?.data);
      if (html?.trim()) return html;
    }
    for (const part of node.parts ?? []) {
      const found = walk(part);
      if (found) return found;
    }
    return null;
  };

  return walk(payload);
}

export interface GmailAttachment {
  /** Gmail's handle for fetching the bytes; absent for inline-only parts. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * The attachment manifest.
 *
 * `format=full` describes attachments but omits their bytes, so this yields
 * handles rather than content. A part counts as an attachment when it has both
 * a filename and an `attachmentId`; that pair excludes the multipart wrappers
 * and the body parts, which have neither.
 */
export function listAttachments(payload: GmailMessagePayload | undefined): GmailAttachment[] {
  const found: GmailAttachment[] = [];
  if (!payload) return found;

  const walk = (node: GmailMessagePayload): void => {
    const attachmentId = node.body?.attachmentId;
    if (node.filename && attachmentId) {
      found.push({
        attachmentId,
        filename: node.filename,
        mimeType: node.mimeType ?? "application/octet-stream",
        sizeBytes: node.body?.size ?? 0,
      });
    }
    for (const part of node.parts ?? []) walk(part);
  };

  walk(payload);
  return found;
}

export interface GmailHeaders {
  messageId: string | null;
  references: string | null;
  inReplyTo: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  replyTo: string | null;
  subject: string | null;
  date: string | null;
}

export function extractHeaders(payload: GmailMessagePayload | undefined): GmailHeaders {
  return {
    messageId: headerValue(payload, "Message-ID"),
    references: headerValue(payload, "References"),
    inReplyTo: headerValue(payload, "In-Reply-To"),
    from: headerValue(payload, "From"),
    to: headerValue(payload, "To"),
    cc: headerValue(payload, "Cc"),
    replyTo: headerValue(payload, "Reply-To"),
    subject: headerValue(payload, "Subject"),
    date: headerValue(payload, "Date"),
  };
}

/**
 * An RFC 5322 message id is angle-bracketed. This matters because
 * `gmail_messages.message_id` is *not* always one — the sync worker substitutes
 * `gmail:<id>` when a message carries no Message-ID header, which is fine as a
 * uniqueness key and invalid as a threading header. Emitting it would produce
 * malformed mail that no client threads.
 */
function isRfcMessageId(value: string | null): value is string {
  const trimmed = value?.trim();
  return Boolean(trimmed?.startsWith("<") && trimmed.endsWith(">") && trimmed.length > 2);
}

export interface ReplyThreadHeaders {
  inReplyTo: string;
  references: string;
}

/**
 * Threading headers for a reply, or null when the parent has no usable id.
 *
 * `In-Reply-To` is the parent's Message-ID; `References` is the parent's own
 * References plus its Message-ID, which is what keeps a long thread together
 * rather than splitting it at every reply. Null means "send it, just without
 * threading" — strictly better than a malformed header.
 */
export function buildReplyHeaders(headers: GmailHeaders): ReplyThreadHeaders | null {
  if (!isRfcMessageId(headers.messageId)) return null;
  const parentId = headers.messageId.trim();
  const priorReferences = headers.references?.trim();
  return {
    inReplyTo: parentId,
    references: priorReferences ? `${priorReferences} ${parentId}` : parentId,
  };
}

/** Splits an address header into bare email addresses. */
export function parseAddresses(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const angled = part.match(/<([^>]+)>/);
      return (angled ? angled[1] : part).trim();
    })
    .filter((address) => address.includes("@"));
}

export interface ReplyRecipients {
  to: string[];
  cc: string[];
}

/**
 * Who a reply goes to.
 *
 * `self` is the connected mailbox, and it is excluded from a reply-all so the
 * account does not mail itself — the sync worker would pull that straight back
 * in as a new message.
 *
 * Passing `self` as null yields **no** Cc even for a reply-all, and that is the
 * point of taking it as an argument rather than reading it inside. The address
 * arrives from a query that has not resolved on first render; an
 * optional-chained comparison against an undefined address matches nothing and
 * quietly keeps the mailbox in its own recipient list. Refusing to guess is the
 * safe direction — a reply-all missing a Cc is visible, a self-addressed loop
 * is not.
 */
export function buildReplyRecipients(
  headers: GmailHeaders,
  self: string | null,
  all: boolean,
): ReplyRecipients {
  const sender = parseAddresses(headers.replyTo ?? headers.from);
  if (!all || !self) return { to: sender, cc: [] };

  const normalisedSelf = self.toLowerCase();
  const cc = [...parseAddresses(headers.to), ...parseAddresses(headers.cc)].filter(
    (address) => address.toLowerCase() !== normalisedSelf && !sender.includes(address),
  );
  return { to: sender, cc };
}

const REPLY_PREFIX = /^\s*(re|رد)\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd?|إعادة توجيه)\s*:/i;

/** "Re: x", never "Re: Re: x". */
export function replySubject(subject: string | null): string {
  const base = subject?.trim() ?? "";
  if (!base) return "Re:";
  return REPLY_PREFIX.test(base) ? base : `Re: ${base}`;
}

export function forwardSubject(subject: string | null): string {
  const base = subject?.trim() ?? "";
  if (!base) return "Fwd:";
  return FORWARD_PREFIX.test(base) ? base : `Fwd: ${base}`;
}

/**
 * The quoted original beneath a reply, in the conventional `>` form so it
 * collapses in the recipient's client.
 */
export function quoteForReply(headers: GmailHeaders, body: string | null): string {
  const attribution = `On ${headers.date ?? "an earlier date"}, ${headers.from ?? "someone"} wrote:`;
  const quoted = (body ?? "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n${attribution}\n${quoted}`;
}

/** The header block a forwarded message carries above the original text. */
export function forwardPreamble(headers: GmailHeaders): string {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${headers.from ?? ""}`,
    `Date: ${headers.date ?? ""}`,
    `Subject: ${headers.subject ?? ""}`,
    `To: ${headers.to ?? ""}`,
  ];
  if (headers.cc) lines.push(`Cc: ${headers.cc}`);
  return `\n\n${lines.join("\n")}\n\n`;
}

/**
 * Recovers Gmail's own message id for a stored row.
 *
 * The `message_id` column is the RFC 822 `Message-ID` header — stable across
 * mailboxes, which is what makes it the right uniqueness key — and only falls
 * back to `gmail:<id>` when a message carried no such header. Gmail's API
 * addresses messages by its own id, so that is read from the stored
 * `format=full` payload, with the prefixed fallback as the second source.
 *
 * Returns null rather than guessing: a caller that cannot identify the message
 * must refuse, not delete the local row and hope.
 */
export function resolveGmailId(row: { message_id: string; raw_payload: unknown }): string | null {
  const payloadId = (row.raw_payload as { id?: unknown } | null | undefined)?.id;
  if (typeof payloadId === "string" && payloadId) return payloadId;
  if (row.message_id.startsWith("gmail:")) return row.message_id.slice("gmail:".length) || null;
  return null;
}
