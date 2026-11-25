import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import {
  contractExpiryDeliveryKey,
  isContractExpiryDeliveryComplete,
} from "@/fns/contractExpiryDelivery";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { templateAllowsChannel } from "@/fns/templateChannelPolicy";
import { readWorkflowGate } from "@/fns/workflowRegistry";
import { translatorFor } from "@/i18n/dictionary";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { joinLocalizedList } from "@/lib/contractUnits";
import {
  contractExpiryTemplate,
  renderEmailDocument,
  type EmailLocale,
} from "@/lib/emailTemplates";
import { stripMarkup } from "@/lib/templateRender";
import { EMAIL_SKIP, WHATSAPP_SKIP } from "@/lib/whatsappSkipReasons";
import { requirePermission } from "@/fns/requirePermission";

/**
 * سبب عدم إنشاء صف لأحد فرعي المستأجر، يُدوَّن في سجل التدقيق لا يُبتلع.
 *
 * A leg this job decides not to queue leaves no notification row by design
 * (see enqueueNotification: a `skipped` row for a channel the admin excluded
 * is the complaint, not evidence). The audit row is therefore the only place
 * "why did the tenant get nothing?" can be answered, so every dropped leg
 * names its reason there.
 */
export type ContractExpirySkip = {
  contract_id: string;
  tenant_id: string;
  leg: "email" | "whatsapp";
  reason: string;
};

async function completedContractExpiryDeliveries(contractId: string, milestone: string) {
  const notifications = await supabaseAdmin
    .from("notifications")
    .select("audience,channel,recipient_address,payload")
    .eq("contract_id", contractId)
    .eq("type", "contract_expiry")
    .in("state", ["queued", "sent"]);
  if (notifications.error) throw new Error(notifications.error.message);

  return new Set(
    notifications.data.flatMap((notification) => {
      const payload = notification.payload;
      const notificationMilestone =
        payload && !Array.isArray(payload) && typeof payload === "object"
          ? payload.milestone
          : null;
      if (
        notificationMilestone !== milestone ||
        (notification.audience !== "admin" && notification.audience !== "tenant") ||
        (notification.channel !== "email" && notification.channel !== "whatsapp") ||
        !notification.recipient_address
      ) {
        return [];
      }
      return [
        contractExpiryDeliveryKey({
          audience: notification.audience,
          channel: notification.channel,
          contractId,
          milestone,
          recipientAddress: notification.recipient_address,
        }),
      ];
    }),
  );
}

const schema = z.object({ asOf: z.string().date().nullable().optional() });

/**
 * يرسل تنبيهات قرب انتهاء العقود للمستأجرين والإدارة، مرة واحدة لكل عقد مؤهل.
 *
 * Candidates come from `identify_contract_expiry_reminders`, which owns the
 * "how close is close" rule; this function only builds and enqueues the
 * notifications, so a change to the reminder windows is a migration, not a code
 * change. Writes an audit row even when nothing was queued — "the job ran and
 * found no expiring contracts" and "the job never ran" must stay tellable apart.
 */
export async function runContractExpiryJob(asOf: string | null = null) {
  // Scheduled jobs read the gate themselves — cronJobs.ts only checks pause
  // before dispatch; targets filter what this job enqueues.
  const { targets } = await readWorkflowGate("contract-expiry");
  const candidates = await supabaseAdmin.rpc("identify_contract_expiry_reminders", {
    p_as_of: asOf,
  });
  if (candidates.error) throw new Error(candidates.error.message);
  const queued: string[] = [];
  const skipped: ContractExpirySkip[] = [];
  // Address-level: admin/company filter only. No targets.includes("admin") guard.
  const adminEmails = await resolveNotificationRecipients(targets);

  // The company row is the same on every iteration — it is the oldest row in a
  // table the platform keeps at one row — so fetching it inside the loop was one
  // round-trip per candidate for an answer that never changed.
  //
  // Skipped entirely when nothing is expiring. Hoisting it unguarded moved the
  // query in front of a `for` loop that used to guard it, so an empty run could
  // be aborted by a transient `companies` error before reaching `write_audit`
  // below — a run with no notifications to send must still record that it ran.
  const companyResult = candidates.data.length
    ? await supabaseAdmin.from("companies").select("*").order("created_at").limit(1).maybeSingle()
    : null;
  if (companyResult?.error) throw new Error(companyResult.error.message);

  for (const candidate of candidates.data) {
    const [tenantResult, contractResult] = await Promise.all([
      supabaseAdmin.from("tenants").select("*").eq("id", candidate.tenant_id).single(),
      supabaseAdmin.from("contracts").select("*").eq("id", candidate.contract_id).single(),
    ]);
    if (tenantResult.error) throw new Error(tenantResult.error.message);
    if (contractResult.error) throw new Error(contractResult.error.message);

    const tenant = tenantResult.data;
    const contract = contractResult.data;
    // Every unit the contract holds (migration 110), not contracts.unit_id
    // (deprecated, no longer read) — a contract may cover several units and
    // the reminder has to name all of them, not just the first.
    const contractUnitResult = await supabaseAdmin
      .from("contract_units")
      .select("unit_id")
      .eq("contract_id", contract.id)
      .order("line_order");
    if (contractUnitResult.error) throw new Error(contractUnitResult.error.message);
    const unitIds = [...new Set(contractUnitResult.data.map((row) => row.unit_id))];
    const unitResult = unitIds.length
      ? await supabaseAdmin.from("units").select("code,name").in("id", unitIds)
      : { data: [] as Array<{ code: string; name: string }>, error: null };
    if (unitResult.error) throw new Error(unitResult.error.message);

    const locale = (tenant.preferred_language ?? "ar") as EmailLocale;
    // Migration 58 replaced the mixed month/day thresholds with eight mutually
    // exclusive DAY buckets, so the wording is derived from the actual number of
    // days rather than from a month count. Previously a contract three days out
    // matched both the `1m` and `7d` arms and one of its two messages read "in
    // 1 month(s)".
    const milestone = candidate.milestone ?? "7d";
    const daysUntil = candidate.days_until ?? 0;
    const t = translatorFor(locale);
    const whenLabel = t("cron.contractExpiry.withinDays").replace("{days}", String(daysUntil));

    const unitLabel = unitResult.data.length
      ? joinLocalizedList(
          unitResult.data.map((unit) => `${unit.code} — ${unit.name}`),
          locale,
        )
      : "—";
    const companyName =
      (locale === "ar" ? companyResult?.data?.name_ar : companyResult?.data?.name_en) ?? "";
    const templateCode = "contract-expiry";
    // unit, days_until and company_name are supplied because migration 58's
    // bodies bind them and migration 73 restores them. They are also the three
    // that make the WhatsApp leg useful — that message is stripMarkup(copy.body),
    // so a placeholder the sender does not fill ships as a literal {{token}}.
    const variables = {
      tenant_name: tenant.name,
      contract_code: contract.code,
      end_date: contract.end_date,
      unit: unitLabel,
      days_until: String(daysUntil),
      company_name: companyName,
    };
    const copy = await loadTemplateCopy(templateCode, locale, variables);
    const builtIn = contractExpiryTemplate({
      locale,
      tenantName: tenant.name,
      contractCode: contract.code,
      endDate: contract.end_date,
    });
    const htmlSubject = copy.subject ?? builtIn.subject;
    const htmlBody = copy.body ? renderEmailDocument(locale, htmlSubject, copy.body) : builtIn.html;
    const plainBody =
      copy.body != null
        ? stripMarkup(copy.body)
        : locale === "ar"
          ? `السيد/ة ${tenant.name}، ينتهي عقد الوحدة ${unitLabel} ${whenLabel} (تاريخ الانتهاء ${contract.end_date}).`
          : `Dear ${tenant.name}, contract for unit ${unitLabel} expires ${whenLabel} (end date ${contract.end_date}).`;

    // tenant_name is carried explicitly so a provider template can bind it as a
    // body parameter — WhatsApp templates read the payload, not the rendered body.
    const payloadBase = {
      milestone,
      // `days_until` is what the seeded template bodies bind to. The old
      // templates used {{months_until_expiry}} while this payload carried
      // `months_until`, so the placeholder never resolved and the literal token
      // shipped to tenants; migration 58 reconciles both ends.
      days_until: daysUntil,
      tenant_name: tenant.name,
      unit: unitLabel,
      end_date: contract.end_date,
    };
    const completedDeliveries = await completedContractExpiryDeliveries(contract.id, milestone);
    const skip = (leg: ContractExpirySkip["leg"], reason: string) =>
      skipped.push({ contract_id: contract.id, tenant_id: tenant.id, leg, reason });

    // Tenant is block-level: off suppresses email AND WhatsApp.
    if (!targets.includes("tenant")) {
      skip("email", WHATSAPP_SKIP.tenantNotTargeted);
      skip("whatsapp", WHATSAPP_SKIP.tenantNotTargeted);
    } else {
      // Tenant email
      const tenantEmailDelivery = tenant.email
        ? {
            audience: "tenant" as const,
            channel: "email" as const,
            contractId: contract.id,
            milestone,
            recipientAddress: tenant.email,
          }
        : null;
      // The template's channel gates the leg before the delivery ledger does:
      // a channel the admin excluded must never be recorded as a completed
      // delivery, or re-enabling it later would look already-sent.
      // The tenant's reminders switch is channel-agnostic. Until now only the
      // WhatsApp leg read it, so a tenant who opted out still got the email.
      if (!tenant.reminders_enabled) skip("email", EMAIL_SKIP.remindersDisabled);
      else if (!tenantEmailDelivery) skip("email", EMAIL_SKIP.noAddress);
      else if (!templateAllowsChannel(copy.channel, "email")) {
        skip("email", EMAIL_SKIP.templateExcludesChannel);
      } else if (isContractExpiryDeliveryComplete(completedDeliveries, tenantEmailDelivery)) {
        skip("email", EMAIL_SKIP.alreadyDelivered);
      } else {
        const row = await enqueueNotification({
          type: "contract_expiry",
          channel: "email",
          audience: "tenant",
          locale,
          tenantId: tenant.id,
          contractId: contract.id,
          deliveryKey: contractExpiryDeliveryKey(tenantEmailDelivery),
          subject: htmlSubject,
          body: htmlBody,
          recipientAddress: tenant.email,
          templateCode,
          payload: { ...payloadBase, recipients: [tenant.email] },
        });
        if (row) queued.push(row.id);
      }

      // Tenant WhatsApp
      const wa = tenant.whatsapp ?? tenant.mobile;
      const tenantWhatsAppDelivery = wa
        ? {
            audience: "tenant" as const,
            channel: "whatsapp" as const,
            contractId: contract.id,
            milestone,
            recipientAddress: wa,
          }
        : null;
      // Reminders-off is checked here as well as in the dispatcher: the row
      // is never created, so the dispatcher's own reason would have nowhere
      // to be written.
      if (!tenant.reminders_enabled) skip("whatsapp", WHATSAPP_SKIP.remindersDisabled);
      else if (!tenantWhatsAppDelivery) skip("whatsapp", WHATSAPP_SKIP.noNumber);
      else if (!templateAllowsChannel(copy.channel, "whatsapp")) {
        skip("whatsapp", WHATSAPP_SKIP.templateExcludesChannel);
      } else if (isContractExpiryDeliveryComplete(completedDeliveries, tenantWhatsAppDelivery)) {
        skip("whatsapp", WHATSAPP_SKIP.alreadyDelivered);
      } else {
        const row = await enqueueNotification({
          type: "contract_expiry",
          channel: "whatsapp",
          audience: "tenant",
          locale,
          tenantId: tenant.id,
          contractId: contract.id,
          deliveryKey: contractExpiryDeliveryKey(tenantWhatsAppDelivery),
          subject: null,
          body: plainBody,
          recipientAddress: wa,
          templateCode,
          payload: payloadBase,
        });
        if (row) queued.push(row.id);
      }
    }

    // Admin email — operational alert stays code-built (includes milestone/unit
    // context the tenant template does not); template_code still tags the row.
    // Address-level only: runs whenever resolveNotificationRecipients is non-empty.
    if (adminEmails.length && templateAllowsChannel(copy.channel, "email")) {
      const adminEmailDelivery = {
        audience: "admin" as const,
        channel: "email" as const,
        contractId: contract.id,
        milestone,
        recipientAddress: adminEmails[0],
      };
      if (isContractExpiryDeliveryComplete(completedDeliveries, adminEmailDelivery)) continue;
      const adminSubject =
        locale === "ar"
          ? `تنبيه انتهاء عقد — ${tenant.name} (${milestone})`
          : `Contract expiry — ${tenant.name} (${milestone})`;
      const adminUnitCodes = unitResult.data.length
        ? joinLocalizedList(
            unitResult.data.map((unit) => unit.code),
            locale,
          )
        : "—";
      const adminBody =
        locale === "ar"
          ? `<p>عقد المستأجر <strong>${tenant.name}</strong> للوحدة <strong>${adminUnitCodes}</strong> ينتهي بتاريخ <strong>${contract.end_date}</strong> (${whenLabel}).</p>`
          : `<p>Tenant <strong>${tenant.name}</strong> contract for unit <strong>${adminUnitCodes}</strong> ends on <strong>${contract.end_date}</strong> (${whenLabel}).</p>`;
      const row = await enqueueNotification({
        type: "contract_expiry",
        channel: "email",
        audience: "admin",
        locale,
        tenantId: tenant.id,
        contractId: contract.id,
        deliveryKey: contractExpiryDeliveryKey(adminEmailDelivery),
        subject: adminSubject,
        body: adminBody,
        recipientAddress: adminEmails[0],
        templateCode,
        payload: { ...payloadBase, recipients: adminEmails },
      });
      if (row) queued.push(row.id);
    }
  }

  const auditResult = await supabaseAdmin.rpc("write_audit", {
    p_action: "job.contract_expiry",
    p_entity_type: "notification",
    p_entity_id: null,
    p_before: null,
    p_after: { as_of: asOf, queued: queued.length, skipped },
    p_result: "success",
    p_error_code: null,
  });
  if (auditResult.error) throw new Error(auditResult.error.message);
  return { count: queued.length, notifications: queued, skipped };
}

export type ContractExpiryJobInput = z.infer<typeof schema>;

export const contractExpiryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.create",
      attempted: "contract_expiry.run",
      refusal: "You do not have permission to queue notifications.",
    });
    return runContractExpiryJob(data.asOf ?? null);
  });
