import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { enqueueNotification } from "@/fns/enqueueNotification";
import { estimatedDrainCapacityWithinStaleWindow } from "@/fns/notificationDrainJob";
import { buildFinalMessage } from "@/fns/resolveTemplateVariables";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, LocaleCode, Tables } from "@/integrations/supabase/database.types";
import { isTemplateOfferable } from "@/lib/templateEligibility";
import { requirePermission } from "@/fns/requirePermission";

export { estimatedDrainCapacityWithinStaleWindow } from "@/fns/notificationDrainJob";

export const sendBulkSchema = z
  .object({
    audience: z.enum(["all", "with_active_contract", "selected"]),
    tenantIds: z.array(z.string().uuid()).optional(),
    channel: z.enum(["email", "whatsapp", "both"]),
    locale: z.enum(["ar", "en"]).nullable().optional(),
    templateCode: z.string().trim().max(120).nullable().optional(),
    subject: z.string().trim().max(300).nullable().optional(),
    body: z.string().trim().max(10000).nullable().optional(),
    respectRemindersEnabled: z.boolean().default(true),
  })
  .refine((v) => v.templateCode || v.body, {
    message: "Select a template or enter message text.",
  })
  .refine((v) => v.audience !== "selected" || (v.tenantIds && v.tenantIds.length > 0), {
    message: "Select at least one tenant.",
  });

export type SendBulkNotificationInput = z.infer<typeof sendBulkSchema>;

export interface BulkSkip {
  tenantId: string;
  reason: string;
}

export interface SendBulkNotificationResult {
  queued: number;
  skipped: BulkSkip[];
  batchId: string;
  /** Max rows the daily drain can clear before the 72h stale cancel. */
  drainCapacity: number;
  exceedsDrainCapacity: boolean;
}

/**
 * يحمّل قائمة المستأجرين حسب جمهور الإرسال الجماعي.
 */
async function loadAudienceTenants(
  audience: SendBulkNotificationInput["audience"],
  tenantIds: string[] | undefined,
): Promise<Tables<"tenants">[]> {
  if (audience === "selected") {
    const ids = tenantIds ?? [];
    if (!ids.length) return [];
    const result = await supabaseAdmin.from("tenants").select("*").in("id", ids);
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  }

  const result = await supabaseAdmin.from("tenants").select("*");
  if (result.error) throw new Error(result.error.message);
  const all = result.data ?? [];
  if (audience === "all") return all;

  const contracts = await supabaseAdmin
    .from("contracts")
    .select("tenant_id")
    .eq("state", "active")
    .is("archived_at", null);
  if (contracts.error) throw new Error(contracts.error.message);
  const activeTenantIds = new Set((contracts.data ?? []).map((row) => row.tenant_id));
  return all.filter((tenant) => activeTenantIds.has(tenant.id));
}

/**
 * يختار عنوان المستلم للقناة كما يفعل sendNotification.
 */
function recipientForChannel(
  tenant: Tables<"tenants">,
  channel: SendBulkNotificationInput["channel"],
): { address: string | null; skipReason: string | null } {
  const emailRecipient = tenant.email?.trim() || null;
  const whatsappRecipient = (tenant.whatsapp ?? tenant.mobile)?.trim() || null;
  if (channel === "email") {
    return emailRecipient
      ? { address: emailRecipient, skipReason: null }
      : { address: null, skipReason: "no_email" };
  }
  if (channel === "whatsapp") {
    return whatsappRecipient
      ? { address: whatsappRecipient, skipReason: null }
      : { address: null, skipReason: "no_whatsapp" };
  }
  const both = emailRecipient ?? whatsappRecipient;
  return both ? { address: both, skipReason: null } : { address: null, skipReason: "no_address" };
}

/**
 * يبني مفتاح تسليم حتمي لكل (دفعة، مستأجر) لمنع الإدراج المزدوج عند النقر المزدوج.
 */
export function bulkDeliveryKey(parts: {
  batchId: string;
  tenantId: string;
  templateCode: string | null;
  channel: string;
}): string {
  return `bulk:${parts.batchId}:${parts.tenantId}:${parts.templateCode ?? "free"}:${parts.channel}`;
}

/**
 * يرسل رسالة يدوية أو قالبًا إلى مجموعة من المستأجرين دفعة واحدة.
 *
 * الصفوف تُدرَج كـ queued عبر enqueueNotification({ dispatch: false }) ويسلّمها
 * notificationDrainJob. DRAIN_BATCH_LIMIT=100 لكل تشغيل وSTALE_AFTER_HOURS=72:
 * مع cron يومي تُقدَّر السعة بـ 100×3=300. ما يبقى بعد 72 ساعة يُلغى لا يُرسل —
 * لذلك نعيد exceedsDrainCapacity ونُظهر تحذيرًا في الحوار قبل الإرسال.
 *
 * المتغيرات تُحلّ لكل مستأجر عبر buildFinalMessage — نفس دالة المعاينة والإرسال الفردي.
 *
 * المستأجر الذي أُوقف إشعاراته يُتخطّى قبل أي فحص آخر ويُذكر في `skipped`
 * بسبب `notifications_paused`، حتى لا يبدو التخطي عطلًا في القالب.
 */
export const sendBulkNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(sendBulkSchema)
  .handler(async ({ data, context }): Promise<SendBulkNotificationResult> => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.send_bulk",
      refusal: "You do not have permission to send notifications.",
    });

    if (data.templateCode) {
      const templateResult = await supabaseAdmin
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
      const jobs = await supabaseAdmin.from("cron_jobs").select("key, recipient_targets");
      if (jobs.error) throw new Error(jobs.error.message);
      if (!isTemplateOfferable(template.type, jobs.data ?? [])) {
        throw new Error("Template is not available for manual sending.");
      }
    }

    const batchId = crypto.randomUUID();
    const tenants = await loadAudienceTenants(data.audience, data.tenantIds);
    const skipped: BulkSkip[] = [];
    let queued = 0;
    const drainCapacity = estimatedDrainCapacityWithinStaleWindow();

    for (const tenant of tenants) {
      // The tenant's own pause comes first: the owner asked for nothing to
      // reach this tenant, and the reminder switch is a separate, weaker
      // opt-out. Skipping here keeps the row out of the queue entirely rather
      // than letting the dispatcher drop it later.
      if (tenant.notifications_paused) {
        skipped.push({ tenantId: tenant.id, reason: "notifications_paused" });
        continue;
      }

      if (data.respectRemindersEnabled && !tenant.reminders_enabled) {
        skipped.push({ tenantId: tenant.id, reason: "reminders_disabled" });
        continue;
      }

      const { address, skipReason } = recipientForChannel(tenant, data.channel);
      if (!address) {
        skipped.push({ tenantId: tenant.id, reason: skipReason ?? "no_address" });
        continue;
      }

      const resolvedLocale: LocaleCode = data.locale ?? tenant.preferred_language ?? "ar";

      const final = await buildFinalMessage({
        tenantId: tenant.id,
        templateCode: data.templateCode ?? null,
        locale: resolvedLocale,
        contractId: null,
        subject: data.subject ?? null,
        body: data.body ?? null,
      });
      if (final.unavailableReason) {
        skipped.push({ tenantId: tenant.id, reason: "template_unavailable" });
        continue;
      }
      // Same rule as a single send (M10): never mail a blank placeholder. In a
      // bulk send one tenant's gap skips that tenant, not the whole batch, and
      // the skip names the keys.
      if (final.missing.length) {
        skipped.push({
          tenantId: tenant.id,
          reason: `unresolved_variables: ${final.missing.join(", ")}`,
        });
        continue;
      }

      const payload: Json = {
        ...final.variables,
        bulk: true,
        batch_id: batchId,
        reminders_enabled: tenant.reminders_enabled,
        recipient: address,
      };

      // One object — dispatch lives on the input, not a second argument.
      // deliveryKey makes a double-clicked bulk send idempotent (23505 → existing row).
      await enqueueNotification({
        type: "manual_message",
        channel: data.channel,
        audience: "tenant",
        locale: final.locale,
        tenantId: tenant.id,
        templateCode: final.templateCode,
        subject: final.subject,
        body: final.bodyHtml,
        recipientAddress: address,
        payload,
        dispatch: false,
        deliveryKey: bulkDeliveryKey({
          batchId,
          tenantId: tenant.id,
          templateCode: final.templateCode,
          channel: data.channel,
        }),
      });
      queued += 1;
    }

    const exceedsDrainCapacity = queued > drainCapacity;

    const auditResult = await context.supabase.rpc("write_audit", {
      p_action: "notification.bulk_create",
      p_entity_type: "notification",
      p_entity_id: null,
      p_before: null,
      p_after: {
        audience: data.audience,
        channel: data.channel,
        template_code: data.templateCode ?? null,
        queued,
        skipped: skipped.length,
        batch_id: batchId,
        drain_capacity: drainCapacity,
        exceeds_drain_capacity: exceedsDrainCapacity,
        respect_reminders_enabled: data.respectRemindersEnabled,
      },
      p_result: "success",
      p_error_code: null,
    });
    if (auditResult.error) throw new Error(auditResult.error.message);

    return {
      queued,
      skipped,
      batchId,
      drainCapacity,
      exceedsDrainCapacity,
    };
  });
