import type { MailboxProvider } from "@/hooks/useGmailMessages";

export interface MailboxSender {
  address: string;
  provider: MailboxProvider;
  /** Stable `provider:address` key — an address can legitimately appear twice. */
  id: string;
  /** Admin-facing name from the catalogue, when the list supplies one. */
  label: string | null;
}

/** يبني المعرّف المركّب للمرسِل. */
export function mailboxSenderId(provider: MailboxProvider, address: string): string {
  return `${provider}:${address.trim().toLowerCase()}`;
}

/**
 * يبني قائمة المرسِلين المتاحين من حساب Gmail المرتبط ومن قائمة عناوين Resend.
 *
 * The identity of an option is `(provider, address)` and never the address on
 * its own. A connected Gmail account on the same domain Resend verifies can be
 * sent by *either* provider, and the two behave differently — Gmail threads a
 * reply and can trash it later, Resend does neither but reports bounces. Keying
 * on the address alone would silently collapse those into one choice and pick
 * for the user.
 *
 * Gmail contributes at most one option because Gmail refuses to send as an
 * arbitrary address; it sends as the authenticated account or not at all.
 */
export function buildMailboxSenders(input: {
  gmailAddress: string | null | undefined;
  gmailCanSend: boolean;
  resendAddresses: Array<{ label?: string | null; value: string }>;
}): MailboxSender[] {
  const senders: MailboxSender[] = [];

  const gmail = input.gmailAddress?.trim();
  if (gmail && input.gmailCanSend) {
    senders.push({
      address: gmail,
      provider: "gmail",
      id: mailboxSenderId("gmail", gmail),
      label: null,
    });
  }

  const seen = new Set<string>();
  for (const entry of input.resendAddresses) {
    const address = entry.value.trim();
    if (!address) continue;
    const id = mailboxSenderId("resend", address);
    // The catalogue enforces uniqueness per list, but a whitespace-only
    // difference would slip past it and produce two identical-looking options.
    if (seen.has(id)) continue;
    seen.add(id);
    senders.push({ address, provider: "resend", id, label: entry.label?.trim() || null });
  }

  return senders;
}

/**
 * يختار المرسِل الافتراضي، مع تثبيته على مزوّد الرسالة الأصلية عند الرد.
 *
 * A reply must leave on the provider it arrived on. Gmail threads a reply from
 * headers stored against the original message; re-routing that through Resend
 * would send a message that reads like a reply but joins no conversation, and
 * nothing in the UI would say so. Returning null when the locked provider has
 * no available sender is deliberate — the caller disables sending rather than
 * quietly falling back to the wrong provider.
 */
export function defaultMailboxSender(
  senders: MailboxSender[],
  lockedProvider?: MailboxProvider | null,
): MailboxSender | null {
  if (lockedProvider) {
    return senders.find((sender) => sender.provider === lockedProvider) ?? null;
  }
  return senders[0] ?? null;
}
