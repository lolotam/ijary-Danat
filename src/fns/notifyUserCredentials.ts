import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import {
  tenantCredentialsTemplate,
  welcomeManagerialTemplate,
  type CredentialFields,
  type EmailLocale,
} from "@/lib/emailTemplates";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";
import { stripMarkup } from "@/lib/templateRender";

/**
 * نتيجة إرسال بيانات الدخول: كل الإشعارات، ومنها ما وُجّه لصاحب الحساب وحده.
 *
 * `recipientIds` is a subset of `ids`, never a replacement: the Notification
 * Log still needs every row, while the "was the customer told?" question may
 * only be answered from the owner-directed ones.
 */
export interface CredentialSendResult {
  ids: string[];
  recipientIds: string[];
  skipped?: true;
  reason?: string;
}

export interface NotifyUserCredentialsInput {
  kind: "managerial" | "tenant";
  username: string;
  password: string;
  displayName: string;
  email: string;
  /** The number the account was created with. Tenants override it below. */
  mobile?: string | null;
  tenantId?: string | null;
  locale?: EmailLocale;
}

/** The placeholders an admin may use in the credentials template. */
export interface CredentialVariables extends Record<string, string> {
  display_name: string;
  username: string;
  password: string;
  email: string;
  mobile: string;
  login_url: string;
}

/** يجهّز متغيرات قالب بيانات الدخول من حقول الحساب وعنوان الدخول. */
function credentialVariables(fields: CredentialFields, loginUrl: string): CredentialVariables {
  return {
    display_name: fields.displayName ?? "",
    username: fields.username,
    password: fields.password,
    email: fields.email ?? "",
    mobile: fields.mobile ?? "",
    login_url: loginUrl,
  };
}

/**
 * يبني رسالة بيانات دخول المستأجر للقناتين من القالب القابل للتحرير.
 *
 * Shared by the automatic path (a portal account was just created) and the
 * manual resend on the tenant screen. Those two used to build their own bodies,
 * which is how they came to disagree about which fields a tenant sees.
 */
export async function buildTenantCredentialMessage(params: {
  locale: EmailLocale;
  tenantName: string;
  portalUrl: string;
  fields: CredentialFields;
}): Promise<{ subject: string; html: string; text: string; whatsapp: string }> {
  const copy = await loadTemplateCopy(
    "user-credentials",
    params.locale,
    credentialVariables(params.fields, params.portalUrl),
  );
  const tpl = tenantCredentialsTemplate({
    locale: params.locale,
    tenantName: params.tenantName,
    portalUrl: params.portalUrl,
    intro: copy.body,
    subject: copy.subject,
    fields: params.fields,
  });
  return {
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    // tpl.text already carries every field the HTML box shows, so the two
    // channels cannot drift apart the way two hand-written bodies did.
    whatsapp: [stripMarkup(copy.body), tpl.text].filter(Boolean).join("\n"),
  };
}

/**
 * يُدرج نسخة الإدارة من بيانات الدخول، ويبتلع فشلها وحده.
 *
 * Returns the notification id, or null when enqueue fails or produces no row.
 * Never throws: by the time it runs the tenant's own row is already enqueued,
 * and letting this throw would discard that result and report the account
 * owner as undelivered — the same inversion the row split exists to prevent,
 * arriving through the error path instead of the success one. The caller
 * appends a returned id; this function does not mutate the caller's list.
 */
async function enqueueAdminCredentialCopy(
  input: Parameters<typeof enqueueNotification>[0],
): Promise<string | null> {
  try {
    const note = await enqueueNotification(input);
    return note?.id ?? null;
  } catch (error) {
    console.error("notifyUserCredentials admin copy failed:", error);
    return null;
  }
}

/**
 * يبني صفوف إشعار بيانات الدخول لصاحب الحساب ولنسخة الإدارة، ثم يُرسلها.
 *
 * `recipientIds` is only the owner-directed rows. The admin copy is a second
 * enqueue so a delivered office address cannot answer "did the customer get
 * their password?".
 */
async function enqueueUserCredentials(
  input: NotifyUserCredentialsInput,
  targets: WorkflowRecipientTarget[],
) {
  const locale = input.locale ?? "ar";
  const appUrl = (process.env.PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const loginUrl =
    input.kind === "tenant"
      ? appUrl
        ? `${appUrl}/portal`
        : "/portal"
      : appUrl
        ? `${appUrl}/auth`
        : "/auth";
  // Address-level: admin/company only. Do not gate the admin block on
  // targets.includes("admin") — company-only must still reach companies.email.
  const adminEmails = await resolveNotificationRecipients(targets);
  const ids: string[] = [];
  // Only the rows aimed at the account owner. Both paths also mail a copy
  // to the company and admin addresses on a separate row, so "did the
  // message go out?" and "did the person who needs the password get it?"
  // are different questions. Review finding on PR #206: a composite
  // tenant+admin send let a delivered admin copy mask a failed user send.
  const recipientIds: string[] = [];

  if (input.kind === "managerial") {
    const fields: CredentialFields = {
      displayName: input.displayName,
      username: input.username,
      password: input.password,
      email: input.email,
      mobile: input.mobile ?? null,
    };
    const copy = await loadTemplateCopy(
      "user-credentials",
      locale,
      credentialVariables(fields, loginUrl),
    );
    const tpl = welcomeManagerialTemplate({
      locale,
      displayName: input.displayName,
      loginUrl,
      intro: copy.body,
      subject: copy.subject,
      fields,
    });
    // Deliberately ungated. Sending someone their own login details is account
    // provisioning, not a notification preference: suppressing it produces a
    // user who can never sign in, with nothing on screen to explain why. The
    // recipient here is a staff user, so no recipient_target describes them —
    // `user-credentials-managerial` declares supportedTargets admin/company only.
    const userMail = await enqueueNotification({
      type: "user_credentials",
      bypassTemplateChannel: true,
      channel: "email",
      audience: "admin",
      locale,
      subject: tpl.subject,
      body: tpl.html,
      recipientAddress: input.email,
      templateCode: "user-credentials",
      payload: {
        recipients: [input.email],
        kind: "managerial",
        username: input.username,
      },
    });
    if (userMail) {
      ids.push(userMail.id);
      recipientIds.push(userMail.id);
    }

    // Copy to company/admin emails (excluding the user if same)
    const adminOnly = adminEmails.filter((email) => email !== input.email.toLowerCase());
    if (adminOnly.length) {
      const adminMail = await enqueueNotification({
        type: "user_credentials",
        bypassTemplateChannel: true,
        channel: "email",
        audience: "admin",
        locale,
        subject: `[Admin] ${tpl.subject}`,
        body: tpl.html,
        recipientAddress: adminOnly[0],
        templateCode: "user-credentials",
        payload: {
          recipients: adminOnly,
          kind: "managerial",
          username: input.username,
          for_user: input.email,
        },
      });
      if (adminMail) ids.push(adminMail.id);
    }
    return { ids, recipientIds };
  }

  // Tenant path. The admin copy is a second row, never a CC on the tenant's:
  // a composite send used to report the tenant as delivered when SMTP had
  // accepted only an admin address (review finding on PR #206).
  let tenantName = input.displayName;
  // Falls back to the number the account was created with, so a tenant record
  // that has no whatsapp/mobile on file still shows one in the mail.
  let wa: string | null = input.mobile?.trim() || null;
  let tenantLocale = locale;
  if (input.tenantId) {
    const tenant = await companyClient(requireRequestCompany().id)
      .from("tenants")
      .select("name, whatsapp, mobile, preferred_language, email")
      .eq("id", input.tenantId)
      .single();
    if (!tenant.error && tenant.data) {
      tenantName = tenant.data.name;
      wa = tenant.data.whatsapp ?? tenant.data.mobile ?? wa;
      tenantLocale = (tenant.data.preferred_language ?? locale) as EmailLocale;
    }
  }

  // The tenant's own portal credentials are ungated for the same reason as the
  // managerial mail above: an account whose owner never receives its password
  // is a broken account, not a quieter one. Only the WhatsApp copy below —
  // a duplicate of a message already sent by email — honours the tenant pill.
  const tpl = await buildTenantCredentialMessage({
    locale: tenantLocale,
    tenantName,
    portalUrl: loginUrl,
    fields: {
      displayName: tenantName,
      username: input.username,
      password: input.password,
      email: input.email,
      mobile: wa,
    },
  });

  const tenantMail = await enqueueNotification({
    type: "user_credentials",
    bypassTemplateChannel: true,
    channel: "email",
    audience: "tenant",
    locale: tenantLocale,
    tenantId: input.tenantId ?? null,
    subject: tpl.subject,
    body: tpl.html,
    recipientAddress: input.email,
    templateCode: "user-credentials",
    payload: {
      recipients: [input.email],
      kind: "tenant",
      username: input.username,
    },
  });
  if (tenantMail) {
    ids.push(tenantMail.id);
    recipientIds.push(tenantMail.id);
  }

  const adminOnly = adminEmails.filter((email) => email !== input.email.toLowerCase());
  if (adminOnly.length) {
    // Isolated, because the tenant's row has already been enqueued by this
    // point. A throw here — a failed insert, a failed pre-dispatch lookup —
    // would discard the populated `recipientIds`, and `createAppUser` catches
    // the rejection and reports `credentialDelivery: "failed"` for an owner who
    // did receive their password. The admin copy must not be able to decide the
    // owner's delivery status through its error path any more than through its
    // success. Review round 3 on PR #211.
    const adminCopyId = await enqueueAdminCredentialCopy({
      type: "user_credentials",
      bypassTemplateChannel: true,
      channel: "email",
      audience: "admin",
      locale: tenantLocale,
      subject: `[Admin] ${tpl.subject}`,
      body: tpl.html,
      recipientAddress: adminOnly[0],
      templateCode: "user-credentials",
      // Kept on the admin copy so it stays visible in tenant-filtered
      // Notification Log views — `useNotifications` derives the displayed
      // tenant from this column, and the old combined row carried it. The
      // `admin` audience is what stops the dispatcher adding the tenant's own
      // address to this send. Review round 2 on PR #211.
      tenantId: input.tenantId ?? null,
      payload: {
        recipients: adminOnly,
        kind: "tenant_copy",
        username: input.username,
        for_user: input.email,
      },
    });
    if (adminCopyId) ids.push(adminCopyId);
  }

  // The WhatsApp leg IS gated: it duplicates credentials the email already
  // delivered, so honouring an email-only template costs the tenant nothing.
  // Only the email above is provisioning that must not be suppressed, which is
  // why this call omits `bypassTemplateChannel` and enqueueNotification drops
  // the row when the template excludes WhatsApp.
  if (wa && targets.includes("tenant")) {
    const waBody = tpl.whatsapp;
    const waNote = await enqueueNotification({
      type: "user_credentials",
      channel: "whatsapp",
      audience: "tenant",
      locale: tenantLocale,
      tenantId: input.tenantId ?? null,
      subject: null,
      body: waBody,
      recipientAddress: wa,
      templateCode: "user-credentials",
      // display_name / login_url are bindable as provider template parameters.
      // The password is deliberately absent: payload is persisted in the
      // Notification Log, and a plaintext credential must not outlive delivery.
      payload: {
        kind: "tenant",
        display_name: tenantName,
        login_url: loginUrl,
        username: input.username,
      },
    });
    if (waNote) {
      ids.push(waNote.id);
      recipientIds.push(waNote.id);
    }
  }

  return { ids, recipientIds };
}

/**
 * يرسل بيانات الدخول وفق صفّي السجل: حساب إداري أو بوابة مستأجر.
 *
 * One function, two registry rows: the kind already decides which message gets
 * built, so it decides which switch applies. That keeps the two independently
 * switchable without splitting the function in half.
 *
 * The paused result keeps `ids` so createAppUser, which reads it, is unaffected.
 */
export async function notifyUserCredentials(
  input: NotifyUserCredentialsInput,
): Promise<CredentialSendResult> {
  return runEventWorkflow<CredentialSendResult>({
    key: input.kind === "tenant" ? "user-credentials-tenant" : "user-credentials-managerial",
    whenPaused: () => ({
      ids: [],
      recipientIds: [],
      skipped: true as const,
      reason: "Workflow is paused.",
    }),
    run: (targets) => enqueueUserCredentials(input, targets),
  });
}
