import { resolveEmailSender, type EmailSenderProvider } from "@/fns/emailSenderStatus";
import { emailLogoFor } from "@/fns/publicBranding";
import { readPublicBranding } from "@/fns/publicBranding.server";
import {
  stringArray,
  tenantOptedOut,
  type ChannelInput,
  type ChannelOutcome,
  type EnabledConfigs,
  type NotificationIssue,
} from "@/fns/notificationChannel";
import type { Tables } from "@/integrations/supabase/database.types";
import { splitEmailAddresses } from "@/lib/addressList";
import { applyEmailLogo } from "@/lib/emailLogo";
import { emailBrandName } from "@/lib/emailTemplates";
import { sendWithResend } from "@/lib/providers/resend";
import { sendWithSmtp } from "@/lib/providers/smtp";
import {
  DELIVERY_INDETERMINATE,
  ProviderDeliveryError,
  type EmailProviderMessage,
} from "@/lib/providers/types";
import { recordSentResendMessage } from "@/lib/recordSentResendMessage";
import { EMAIL_SKIP } from "@/lib/whatsappSkipReasons";

type EmailConfig = Tables<"provider_configs">;

/**
 * يرتّب مزوّدَي البريد المفعّلين: الافتراضي أولاً ثم الاحتياطي.
 *
 * `is_primary` decides (migration 225). Resend wins a tie — both flagged or,
 * as before 225, neither — because it was the only preference dispatch had.
 */
export function emailProviders(configs: EnabledConfigs): EmailConfig[] {
  return [configs.get("resend"), configs.get("smtp")]
    .filter((config): config is EmailConfig => Boolean(config))
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
}

/**
 * هل يعني هذا الخطأ أن الرسالة ربما وصلت رغم فشل الطلب؟
 *
 * A timeout is the one failure the fallback must not answer: the default
 * provider may have accepted the mail after we stopped waiting, and sending it
 * again through the other provider would reach the tenant twice. SMTP says so
 * with DELIVERY_INDETERMINATE; Resend's fetch rejects with the abort itself.
 */
function mayHaveDelivered(error: unknown): boolean {
  if (error instanceof ProviderDeliveryError) return error.code === DELIVERY_INDETERMINATE;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** يستخرج نص الخطأ لدمجه في سبب الفشل المسجّل على الإشعار. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * يرسل الرسالة عبر مزوّد واحد ويعيد معرّفها والمرسِل الذي استُخدم.
 *
 * The sender address is resolved per provider and a missing one throws here,
 * inside the attempt, so a default with no sender configured falls through to
 * the fallback like any other refusal.
 */
async function sendThrough(
  provider: EmailSenderProvider,
  message: Omit<EmailProviderMessage, "config" | "from">,
): Promise<{ messageId: string; from: string }> {
  if (!provider.from) throw new Error(`${provider.provider} sender address is not configured.`);
  const request = { ...message, config: provider.config, from: provider.from };
  const result =
    provider.provider === "resend" ? await sendWithResend(request) : await sendWithSmtp(request);
  return { messageId: result.messageId, from: provider.from };
}

/**
 * يرسل عبر المزوّد الافتراضي، ثم الاحتياطي إن رفض الافتراضي رفضاً مؤكداً.
 *
 * With no fallback enabled a failure propagates unchanged, exactly as the
 * single-provider dispatch did. When both fail, the error names both and keeps
 * the fallback's code, since that attempt is the one whose delivery the drain
 * job has to reason about.
 */
async function sendWithFallback(
  [primary, fallback]: EmailSenderProvider[],
  message: Omit<EmailProviderMessage, "config" | "from">,
): Promise<{
  provider: EmailSenderProvider;
  messageId: string;
  from: string;
  issue?: NotificationIssue;
}> {
  try {
    return { provider: primary, ...(await sendThrough(primary, message)) };
  } catch (primaryError) {
    if (!fallback || mayHaveDelivered(primaryError)) throw primaryError;
    const cause = `${primary.provider}: ${errorMessage(primaryError)}`;
    try {
      const sent = await sendThrough(fallback, message);
      return {
        provider: fallback,
        ...sent,
        issue: {
          kind: "failure",
          message: `${cause} Sent through the ${fallback.provider} fallback.`,
        },
      };
    } catch (fallbackError) {
      const combined = `${cause}; ${fallback.provider} fallback: ${errorMessage(fallbackError)}`;
      if (fallbackError instanceof ProviderDeliveryError) {
        throw new ProviderDeliveryError(combined, fallbackError.code);
      }
      throw new Error(combined, { cause: fallbackError });
    }
  }
}

/**
 * يرسل قناة البريد لإشعار واحد ويعيد نتيجتها؛ لا يلتقط أخطاء الإرسال.
 *
 * A thrown provider error propagates on purpose: `dispatchNotificationRecord`
 * records the whole row as failed and never attempts WhatsApp after it — the
 * behaviour the unsplit function had (audit M9). The fallback provider is
 * tried inside `sendWithFallback` first; only a failure it cannot answer
 * reaches the caller.
 */
export async function sendEmailChannel(input: ChannelInput): Promise<ChannelOutcome> {
  const { notification, tenant, configs, attachments } = input;
  const issues: NotificationIssue[] = [];
  const messageIds: string[] = [];

  if (tenantOptedOut(notification, tenant)) {
    issues.push({ kind: "skip", message: EMAIL_SKIP.remindersDisabled });
    return { messageIds, issues, provider: null, senderAddress: input.senderAddress };
  }

  // `user_credentials` is excluded from the tenant-record expansion.
  // Every other tenant-audience mail is informational, and copying the
  // address on file is a courtesy; a password is provisioning, and the
  // account's own address is not necessarily `tenants.email`. Adding the
  // second address puts both in ONE send, and SMTP accepting either marks
  // the row `sent` — so `describeDelivery` would report that the account
  // owner has their password because the tenant record's address
  // accepted it. That is the partial-delivery masking the split in
  // `notifyUserCredentials` exists to prevent, reached by a different
  // route. Review round 2 on PR #211.
  const expandsToTenantRecord =
    notification.audience !== "admin" && notification.type !== "user_credentials";
  const recipients = [
    ...splitEmailAddresses(notification.recipient_address),
    ...(tenant?.email && expandsToTenantRecord ? [tenant.email] : []),
    ...stringArray(notification.payload, "recipients"),
  ];
  const uniqueRecipients = [...new Set(recipients.filter(Boolean))];
  if (!uniqueRecipients.length) {
    issues.push({ kind: "skip", message: "No email recipient is available." });
    return { messageIds, issues, provider: null, senderAddress: input.senderAddress };
  }

  // The sender comes from the company, not from a global setting: its own
  // provider rows when it configured one, the platform's default sender when
  // it did not (FR-068). The resolution also carries the company's reply
  // address, so an answer reaches the office rather than the sender.
  const sender = await resolveEmailSender({
    companyId: notification.company_id,
    locale: notification.locale === "en" ? "en" : "ar",
    ownProviders: emailProviders(configs),
  });
  if (!sender.providers.length) {
    // Neither the company nor the platform has a sender. The message is not
    // sent and the row is not retried: no retry configures a sender that is
    // not there, and the Notification Log carries the reason.
    issues.push({ kind: "skip", message: "No email provider is enabled." });
    return { messageIds, issues, provider: null, senderAddress: input.senderAddress };
  }

  // Every automatic email funnels through here, so the logo is applied
  // once rather than in each of the sixteen senders that build the HTML —
  // one of those forgotten is an unbranded email nobody notices.
  //
  // Computed above BOTH the send and the mailbox mirror below: recording
  // the un-substituted body would leave the archive showing a raw marker
  // and disagreeing with what was actually delivered.
  //
  // `notification.body` keeps the marker in the database on purpose, so a
  // resend by runNotificationDrainJob re-substitutes against current
  // branding rather than replaying a stale logo URL.
  const branding = await readPublicBranding();
  const htmlBody = applyEmailLogo(
    notification.body ?? "",
    emailLogoFor(branding),
    emailBrandName(notification.locale === "en" ? "en" : "ar"),
  );
  const sent = await sendWithFallback(sender.providers, {
    body: htmlBody,
    subject: notification.subject ?? "",
    to: uniqueRecipients,
    attachments,
    // The drain retries this same row, so the row id reaches the provider
    // again and a send that timed out after acceptance is recognised rather
    // than delivered twice.
    idempotencyKey: notification.id,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
  });
  messageIds.push(sent.messageId);
  if (sent.issue) issues.push(sent.issue);

  if (sent.provider.provider === "resend") {
    // A notification sent through Resend is mail this company sent, and the
    // mailbox is where sent mail is read. Only the manual compose screen
    // recorded it before, so the Resend filter showed an empty folder while
    // notifications were going out perfectly well.
    //
    // Deliberately not fatal: the mail has already left. Failing the
    // dispatch here would mark a delivered notification as failed, and
    // `runNotificationDrainJob` re-sends failed rows — so a bookkeeping
    // error would turn into a duplicate email to the tenant.
    try {
      await recordSentResendMessage({
        bcc: [],
        body: htmlBody,
        cc: [],
        from: sent.from,
        resendId: sent.messageId,
        source: "dispatchNotification",
        subject: notification.subject ?? "",
        to: uniqueRecipients,
      });
    } catch (error) {
      console.error("[dispatch] recording the sent Resend message failed", error);
    }
  }

  return {
    messageIds,
    issues,
    provider: sent.provider.provider,
    senderAddress: sent.from,
  };
}
