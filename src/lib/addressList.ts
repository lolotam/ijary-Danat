/**
 * يقسم حقل العناوين المكتوب يدويًا على الفواصل والفواصل المنقوطة.
 *
 * The compose To/Bcc fields stay free text; this is how a typed string
 * becomes the address list the sender and the picker both read.
 */
export function parseAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * يقسم سلسلة مستلمين مفصولة بفاصلة إلى عناوين بريد فقط.
 *
 * `notifications.recipient_address` is one text column. Scheduled reports now
 * store every recipient there so the log can show the whole list. Passing the
 * joined string through as a single To: value would make uniqueRecipients a
 * one-element array and hide everyone after the first from the provider.
 */
export function splitEmailAddresses(value: string | null | undefined): string[] {
  if (!value || !value.includes("@")) return [];
  return parseAddresses(value).filter((part) => part.includes("@"));
}

/**
 * يضيف عناوين إلى نص الحقل دون تكرار ودون إعادة كتابة ما كتبه المستخدم.
 *
 * The text field is the single source of truth. A parallel `string[]` of
 * selected tenants is what produces "I deleted an address and it came back"
 * on the next render — the picker would re-append from that array after the
 * user had already edited the field.
 */
export function appendAddresses(current: string, additions: string[]): string {
  const seen = new Set(parseAddresses(current).map((address) => address.toLowerCase()));
  // The set grows as we go: two tenants sharing one address — a family on one
  // mailbox, a company contact reused — would otherwise both be appended,
  // because a set built only from `current` cannot see the batch's own repeats.
  const fresh = additions
    .map((address) => address.trim())
    .filter((address) => {
      const key = address.toLowerCase();
      if (!address || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (fresh.length === 0) return current;
  if (!current.trim()) return fresh.join(", ");

  return `${current.replace(/[\s,;]+$/, "")}, ${fresh.join(", ")}`;
}
