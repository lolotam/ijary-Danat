import { toChatNumber } from "@/lib/whatsappLink";

/** The five inbox sources, each its own tab. */
export const INBOX_TABS = ["tenants", "visitors", "leads", "gmail", "whatsapp"] as const;
/** Gmail sub-tabs (migration 100) — deep-linked via `?folder=`. */
export const GMAIL_FOLDERS = ["received", "sent"] as const;

export type InboxTab = (typeof INBOX_TABS)[number];
export type GmailFolder = (typeof GMAIL_FOLDERS)[number];

export interface InboxSearch {
  message?: string;
  tab?: InboxTab;
  /** `?chat=<digits>` opens that WhatsApp thread; only read when tab=whatsapp. */
  chat?: string;
  /** Gmail Received / Sent; only meaningful when tab=gmail. */
  folder?: GmailFolder;
}

/**
 * يزيل علامات التنصيص حول قيمة المعامل حتى `?tab="gmail"` يفتح تبويب Gmail.
 *
 * Links are pasted and hand-typed as often as they are clicked, and a quoted
 * value is the shape that arrives when someone copies one out of a document.
 */
export function unquoteParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^["']|["']$/g, "");
}

/**
 * يفسّر معاملات رابط صندوق الوارد إلى حالة مفهومة، ويتجاهل ما لا يصلح منها.
 *
 * Lives outside the route file so it can be tested without mounting the page,
 * and so the rules — which tab names exist, how a chat number is normalised —
 * are readable in one place. Invalid values are dropped rather than defaulted:
 * an unusable `?chat=` must leave the inbox on its normal landing tab instead
 * of opening a thread nobody asked for.
 */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const tab = unquoteParam(search.tab);
  // Normalised the same way a stored number is: the link that carries this
  // comes from a tenant record, and `+965 5123 4567` and `96551234567` must
  // land on one thread, not two.
  const chat = toChatNumber(unquoteParam(search.chat));
  return {
    ...(typeof search.message === "string" ? { message: search.message } : {}),
    ...(INBOX_TABS.includes(tab as InboxTab) ? { tab: tab as InboxTab } : {}),
    ...(chat ? { chat } : {}),
    ...(GMAIL_FOLDERS.includes(search.folder as GmailFolder)
      ? { folder: search.folder as GmailFolder }
      : {}),
  };
}
