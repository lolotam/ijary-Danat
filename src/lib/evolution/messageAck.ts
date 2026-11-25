/**
 * تفسير حدث messages.update من Evolution: حالة الإقرار من خادم واتساب لرسالة
 * سبق أن قبلتها البوّابة.
 *
 * Evolution answers 201 to a send the moment Baileys hands the message to the
 * socket. WhatsApp's verdict arrives later as a server ack on the same key,
 * and a rejection ("ERROR", most often code 463 — the reach-out time-lock on
 * a contact with no prior conversation) is the one outcome nothing else in
 * the pipeline can see. Evolution forwards the mapped status string, not the
 * numeric code, so the reason text below names the likely cause rather than
 * asserting it.
 */

export type AckStatus = "ERROR" | "PENDING" | "SERVER_ACK" | "DELIVERY_ACK" | "READ" | "PLAYED";

/** Baileys' numeric WAMessageStatus, in enum order; Evolution maps through it. */
const ACK_BY_NUMBER: readonly AckStatus[] = [
  "ERROR",
  "PENDING",
  "SERVER_ACK",
  "DELIVERY_ACK",
  "READ",
  "PLAYED",
];

/**
 * يطبّع حالة الإقرار سواء وصلت نصاً (Evolution) أو رقماً (Baileys الخام).
 */
export function normalizeAckStatus(value: unknown): AckStatus | null {
  if (typeof value === "number") return ACK_BY_NUMBER[value] ?? null;
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (ACK_BY_NUMBER as readonly string[]).includes(upper) ? (upper as AckStatus) : null;
}

/** Inbox `whatsapp_messages.status` value for an ack, or null when nothing changes. */
export function inboxStatusForAck(status: AckStatus): "delivered" | "failed" | "read" | null {
  switch (status) {
    case "ERROR":
      return "failed";
    case "DELIVERY_ACK":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    default:
      return null;
  }
}

/** Message-key ids are hex from Baileys; anything else is not ours to look up. */
export function isMessageKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{8,64}$/.test(value);
}

export const WHATSAPP_REJECTED_AFTER_SEND =
  "WhatsApp rejected this message after the gateway accepted it (server ack ERROR). " +
  "The usual cause is code 463, WhatsApp's reach-out time-lock on a contact with no prior conversation " +
  "— have the tenant message the company number first, or send the first message from the phone, then re-queue. " +
  "If this repeats for contacts who already chat with us, the gateway's Baileys build is too old for the current WhatsApp privacy tokens.";
