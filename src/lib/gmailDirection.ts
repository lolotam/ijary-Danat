/**
 * Classify a Gmail message as received or sent from its labelIds.
 *
 * SENT wins when both SENT and INBOX are present: a message the account sent
 * is a sent message even if a copy also delivered back into the inbox (Gmail
 * does that when the account mails an address that resolves to itself). Live
 * data has ~25 rows with both labels; without a deterministic rule those would
 * flip folders depending on array order.
 *
 * Empty or missing labels default to received — the safer list for staff who
 * have not yet seen the mail.
 *
 * Read state is derived the same way: Gmail's UNREAD label on the format=full
 * payload. A missing or empty labels array defaults to unread — a message
 * wrongly shown as unread is a minor annoyance; one wrongly hidden as read may
 * never be seen.
 */

export type GmailDirection = "received" | "sent";

/**
 * Pure SENT-wins classifier. Safe to import from browser and server code.
 */
export function classifyGmailDirection(
  labelIds: readonly string[] | null | undefined,
): GmailDirection {
  if (labelIds?.includes("SENT")) return "sent";
  return "received";
}

/**
 * Whether the local `is_read` column should be true for this Gmail payload.
 *
 * Gmail marks unread with the `UNREAD` system label. Missing/empty labelIds
 * default to unread (`false`) — safer than hiding mail staff have not seen.
 */
export function classifyGmailIsRead(labelIds: readonly string[] | null | undefined): boolean {
  // Absent or empty → unread. See module header for why that is the safe default.
  if (!labelIds?.length) return false;
  return !labelIds.includes("UNREAD");
}
