import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { buildFinalMessage } from "@/fns/resolveTemplateVariables";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/database.types";
import { isTemplateOfferable } from "@/lib/templateEligibility";
import { requirePermission } from "@/fns/requirePermission";

export const sendNotificationSchema = z
  .object({
    body: z.string().trim().max(10000).nullable().optional(),
    channel: z.enum(["email", "whatsapp", "both"]),
    /** Pins live variables to one contract for multi-contract tenants. */
    contractId: z.string().uuid().nullable().optional(),
    documentPath: z.string().trim().max(1000).nullable().optional(),
    /** Optional override; when unset falls back to the tenant's preferred language. */
    locale: z.enum(["ar", "en"]).nullable().optional(),
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
    subject: z.string().trim().max(300).nullable().optional(),
    templateCode: z.string().trim().max(120).nullable().optional(),
    tenantId: z.string().uuid(),
    type: z.enum(["manual_message", "document_send", "company_info"]),
    variables: z.record(z.string()).optional(),
  })
  .refine((value) => value.templateCode || value.body, {
    message: "Select a template or enter message text.",
  });

export type SendNotificationInput = z.infer<typeof sendNotificationSchema>;

/**
 * يرسل إشعارًا يدويًا لمستأجر واحد بعد بناء الرسالة النهائية مرة واحدة.
 *
 * Inserts exactly what buildFinalMessage returned — no second render pass —
 * so the preview panel and the persisted row are the same bytes.
 */
export const sendNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(sendNotificationSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.send",
      refusal: "You do not have permission to send notifications.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const tenantResult = await db.from("tenants").select("*").eq("id", data.tenantId).single();
    if (tenantResult.error) throw new Error(tenantResult.error.message);
    const tenant = tenantResult.data;

    // Channel check against the requested template code. Eligibility is
    // enforced here — a filtered dropdown is presentation, not a control.
    if (data.templateCode) {
      const templateResult = await db
        .from("notification_templates")
        .select("*")
        .eq("code", data.templateCode)
        .eq("is_active", true)
        .single();
      if (templateResult.error) throw new Error(templateResult.error.message);
      const template = templateResult.data;
      if (template.channel !== "both" && template.channel !== data.channel) {
        throw new Error("Template channel does not match the selected channel.");
      }
      const jobs = await db.from("cron_jobs").select("key, recipient_targets");
      if (jobs.error) throw new Error(jobs.error.message);
      if (!isTemplateOfferable(template.type, jobs.data ?? [])) {
        throw new Error("Template is not available for manual sending.");
      }
    }

    const resolvedLocale = data.locale ?? tenant.preferred_language;

    const final = await buildFinalMessage({
      tenantId: tenant.id,
      templateCode: data.templateCode ?? null,
      locale: resolvedLocale,
      contractId: data.contractId ?? null,
      subject: data.subject ?? null,
      body: data.body ?? null,
      variables: data.variables,
    });
    if (final.unavailableReason) {
      throw new Error(final.unavailableReason);
    }
    if (final.missing.length) {
      throw new Error(
        `Cannot send: these variables have no value — ${final.missing
          .map((key) => `{{${key}}}`)
          .join(", ")}. Fill them in or choose another template.`,
      );
    }

    const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
    const emailRecipient = tenant.email?.trim() || null;
    const whatsappRecipient = (tenant.whatsapp ?? tenant.mobile)?.trim() || null;
    if (data.channel === "email" && !emailRecipient) {
      throw new Error("Tenant has no email address.");
    }
    if (data.channel === "whatsapp" && !whatsappRecipient) {
      throw new Error("Tenant has no WhatsApp or mobile number.");
    }
    if (data.channel === "both" && !emailRecipient && !whatsappRecipient) {
      throw new Error("Tenant has no email or WhatsApp number.");
    }
    const recipientAddress =
      data.channel === "whatsapp"
        ? whatsappRecipient
        : data.channel === "email"
          ? emailRecipient
          : (emailRecipient ?? whatsappRecipient);

    const payload: Json = {
      ...final.variables,
      document_path: data.documentPath ?? null,
      reminders_enabled: tenant.reminders_enabled,
      recipient: recipientAddress,
      contract_id: data.contractId ?? null,
    };

    // Persist the builder output verbatim — the parity test asserts this.
    const insertResult = await db
      .from("notifications")
      .insert({
        audience: "tenant",
        company_id: company.id,
        tenant_id: tenant.id,
        type: data.type,
        channel: data.channel,
        locale: final.locale,
        template_code: final.templateCode,
        subject: final.subject,
        body: final.bodyHtml,
        payload,
        recipient_address: recipientAddress,
        scheduled_at: scheduledAt?.toISOString() ?? null,
        contract_id: data.contractId ?? null,
      })
      .select("*")
      .single();
    if (insertResult.error) throw new Error(insertResult.error.message);

    const auditResult = await context.supabase.rpc("write_audit", {
      p_action: "notification.create",
      p_entity_type: "notification",
      p_entity_id: insertResult.data.id,
      p_before: null,
      p_after: {
        channel: insertResult.data.channel,
        state: insertResult.data.state,
        tenant_id: insertResult.data.tenant_id,
        type: insertResult.data.type,
      },
      p_result: "success",
      p_error_code: null,
    });
    if (auditResult.error) throw new Error(auditResult.error.message);
    if (scheduledAt && scheduledAt.getTime() > Date.now()) return insertResult.data;
    return dispatchNotificationRecord(insertResult.data.id);
  });
