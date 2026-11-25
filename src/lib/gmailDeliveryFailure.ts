/**
 * كشف رسائل فشل التسليم (DSN) القادمة من Gmail في صندوق الوارد.
 *
 * Gmail's Mailer-Daemon bounce is the only delivery failure this inbox can
 * see: outbound mail leaves through SMTP/Resend, and the only bounce that
 * comes back is a new inbound message. Detecting it from the sender and the
 * X-Failed-Recipients header is enough to surface the failed address without
 * parsing the full DSN MIME tree.
 */

const MAILER_DAEMON = /mailer-daemon@(?:googlemail\.com|google\.com)\b/i;
const MAILER_DAEMON_LOCAL = /^mailer-daemon@/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface GmailDeliveryFailureInput {
  fromAddress?: string | null;
  snippet?: string | null;
  /** Raw `X-Failed-Recipients` header value, when the full payload is loaded. */
  failedRecipientsHeader?: string | null;
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailDeliveryFailure {
  isDeliveryFailure: boolean;
  failedRecipients: string[];
}

/**
 * يستخرج عنوان X-Failed-Recipients من قائمة ترويسات الرسالة.
 */
export function failedRecipientsHeaderValue(
  headers: Array<{ name: string; value: string }> | undefined,
): string | null {
  const header = headers?.find((item) => item.name.toLowerCase() === "x-failed-recipients");
  const value = header?.value?.trim();
  return value || null;
}

/**
 * يجمع عناوين البريد من نص حر دون تكرار، مع استبعاد عنوان Mailer-Daemon نفسه.
 */
function emailsFromText(value: string | null | undefined): string[] {
  if (!value) return [];
  const found = value.match(EMAIL_IN_TEXT) ?? [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of found) {
    if (MAILER_DAEMON_LOCAL.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(raw);
  }
  return unique;
}

/**
 * يقرر إن كانت الرسالة إشعار فشل تسليم، ويستخرج عنوان المستلم الفاشل.
 *
 * A list row only has `from_address` + `snippet`. The open sheet also has
 * headers. Either the Mailer-Daemon sender or a present X-Failed-Recipients
 * header is enough — Gmail always sets both, but a forwarded DSN may keep
 * only the header.
 */
export function detectGmailDeliveryFailure(input: GmailDeliveryFailureInput): GmailDeliveryFailure {
  const header = input.failedRecipientsHeader?.trim() || failedRecipientsHeaderValue(input.headers);
  const isDeliveryFailure = MAILER_DAEMON.test(input.fromAddress ?? "") || Boolean(header);
  if (!isDeliveryFailure) return { isDeliveryFailure: false, failedRecipients: [] };

  // The header is the DSN's own recipient list. The snippet is a prose
  // preview and often names support@, the original From, or other mailboxes
  // that did not bounce — those must not join the failed list when the
  // header already named the real one.
  // A present header is exclusive even when it parses to zero mailboxes.
  // Falling back to the snippet on a malformed header is how support@ and
  // the original From get listed as bounces.
  if (header) return { isDeliveryFailure: true, failedRecipients: emailsFromText(header) };
  return { isDeliveryFailure: true, failedRecipients: emailsFromText(input.snippet) };
}

export interface HighlightedSnippetPart {
  text: string;
  failed: boolean;
}

/**
 * يجزّئ المقتطف إلى أجزاء ليُبرَز عنوان المستلم الفاشل داخل النص.
 *
 * Matching is case-insensitive; the original snippet casing is kept so the
 * preview still looks like the mail Gmail stored.
 */
export function highlightFailedRecipients(
  snippet: string,
  failedRecipients: string[],
): HighlightedSnippetPart[] {
  if (!snippet || failedRecipients.length === 0) return [{ text: snippet, failed: false }];
  const pattern = new RegExp(
    `(${[...failedRecipients]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|")})`,
    "gi",
  );
  const parts: HighlightedSnippetPart[] = [];
  let last = 0;
  for (const match of snippet.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: snippet.slice(last, index), failed: false });
    parts.push({ text: match[0], failed: true });
    last = index + match[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), failed: false });
  return parts.length ? parts : [{ text: snippet, failed: false }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
