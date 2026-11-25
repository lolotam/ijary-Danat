/**
 * Working out what a person typed into the login box.
 *
 * Three things are accepted — username, email address, or mobile number — and
 * none of them is the thing GoTrue authenticates with. GoTrue only knows the
 * account's email, so an identifier has to be resolved to one first.
 *
 * Pure and client-free on purpose: the matching rules below are the part most
 * likely to be subtly wrong, and they are worth testing without a database.
 */

/** Kuwaiti subscriber numbers are 8 digits; the country code is 965. */
const NATIONAL_NUMBER_LENGTH = 8;

/**
 * Reduces a phone number to the part that identifies the subscriber.
 *
 * Exact string matching on phone numbers does not work, and assuming it does is
 * how this feature would ship looking complete while failing for most people.
 * `profiles.phone` is free text: the same mobile is stored as `51234567`,
 * `+965 5123 4567`, `00965-51234567` and `965 51234567` depending on who typed
 * it. A tenant enters it the way they know it, which is rarely the way an admin
 * recorded it.
 *
 * Comparing the last 8 digits collapses all of those onto the same value.
 * Returns null when there are not enough digits to be a real number, so a short
 * string can never match a suffix by accident.
 */
export function nationalPhoneDigits(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length < NATIONAL_NUMBER_LENGTH) return null;
  return digits.slice(-NATIONAL_NUMBER_LENGTH);
}

export type IdentifierKind = "email" | "phone" | "username";

/**
 * What the input looks like. Used to decide which columns are worth searching,
 * not to reject anything — a value that looks like none of these is still tried
 * as a username.
 */
export function classifyIdentifier(identifier: string): IdentifierKind {
  const trimmed = identifier.trim();
  if (trimmed.includes("@")) return "email";
  // A username is constrained to `[a-zA-Z0-9._-]` by createAppUser, so anything
  // that is essentially digits (allowing +, spaces, dashes) is a phone attempt.
  if (/^[+\d][\d\s()+-]*$/.test(trimmed) && nationalPhoneDigits(trimmed)) return "phone";
  return "username";
}

/**
 * The legacy mapping, kept exactly as it was.
 *
 * Accounts created without a real email address authenticate as
 * `<username>@users.local`. This is the fallback when no profile row matches,
 * which keeps every login that works today working — including admin logins,
 * which is why it is not simply replaced.
 */
export function loginIdentifierToEmail(identifier: string): string {
  const normalizedIdentifier = identifier.trim().toLowerCase();
  return normalizedIdentifier.includes("@")
    ? normalizedIdentifier
    : `${normalizedIdentifier}@users.local`;
}
