/**
 * نصوص أسباب تخطّي/فشل واتساب الموحّدة، تُقرأ في سجل الإشعارات وسجل التدقيق.
 *
 * One vocabulary for the three places a WhatsApp leg can be dropped: the
 * dispatcher, the scheduled jobs, and the Evolution adapter. An admin reading
 * "why did the tenant get no message?" sees the same sentence wherever the
 * decision was made, and a test can assert on the constant rather than on a
 * string that drifts per file.
 */
export const WHATSAPP_SKIP = {
  remindersDisabled: "WhatsApp skipped: tenant reminders are disabled.",
  noNumber: "WhatsApp skipped: no WhatsApp number available on tenant.",
  noProvider: "WhatsApp skipped: no active WhatsApp provider in provider_configs.",
  templateExcludesChannel: "WhatsApp skipped: the template excludes the WhatsApp channel.",
  alreadyDelivered: "WhatsApp already queued or sent for this milestone.",
  tenantNotTargeted: "WhatsApp skipped: the workflow's recipient targets exclude the tenant.",
} as const;

export const EMAIL_SKIP = {
  noAddress: "Email skipped: no email address on tenant.",
  templateExcludesChannel: "Email skipped: the template excludes the email channel.",
  alreadyDelivered: "Email already queued or sent for this milestone.",
  remindersDisabled: "Email skipped: reminders are disabled for this tenant.",
} as const;

/**
 * يصوغ رسالة انقطاع جلسة Evolution مع الإجراء المطلوب من الإنسان.
 *
 * Carries the observed state so a `connecting` (QR shown, never scanned) reads
 * differently from a `close` (WhatsApp unlinked the device) in the log.
 */
export function evolutionSessionDisconnectedReason(state: string | null): string {
  return (
    `WhatsApp failed: Evolution QR session disconnected (state: ${state ?? "unknown"}). ` +
    "Re-scan the QR code in Settings → Integrations, then re-queue."
  );
}
