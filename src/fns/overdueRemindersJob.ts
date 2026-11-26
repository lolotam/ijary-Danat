import { companyClient } from "@/company/companyClient.server";
import { companyOriginById } from "@/company/companyUrl.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { templateAllowsChannel } from "@/fns/templateChannelPolicy";
import { readWorkflowGate } from "@/fns/workflowRegistry";
import { translatorFor } from "@/i18n/dictionary";
import {
  overdueReminderTemplate,
  portalInvoicesUrl,
  renderEmailDocument,
  type EmailLocale,
} from "@/lib/emailTemplates";
import { formatKwd } from "@/lib/money";
import { stripMarkup } from "@/lib/templateRender";
import { WHATSAPP_SKIP } from "@/lib/whatsappSkipReasons";

/**
 * يرسل تذكيرات المتأخرات شهرياً: بريد وواتساب مرة واحدة لكل مستأجر في الشهر،
 * ويدوّن في سجل التدقيق كل مستأجر لم يصله فرع الواتساب ولماذا.
 *
 * Monthly-style overdue reminders: for each tenant with open overdue balance
 * and reminders enabled, send email + WhatsApp once per calendar month. A
 * tenant this job decides not to message leaves no notification row, so the
 * audit row carries the reason — otherwise "why did nobody get a reminder?"
 * has no answer anywhere.
 */
export async function runOverdueRemindersJob(asOf: string | null = null, companyId?: string) {
  const jobCompanyId = companyId ?? requireRequestCompany().id;
  const db = companyClient(jobCompanyId);
  // Scheduled jobs read the gate themselves — cronJobs.ts only checks pause
  // before dispatch; targets filter what this job enqueues.
  const { targets } = await readWorkflowGate("overdue-reminders");
  const asOfDate = asOf ?? new Date().toISOString().slice(0, 10);
  const monthKey = asOfDate.slice(0, 7); // YYYY-MM

  const overdueInvoices = await db
    .from("invoices")
    .select("id, tenant_id, contract_id, balance, due_date, period_month, period_year, code")
    .eq("state", "overdue")
    .gt("balance", 0);
  if (overdueInvoices.error) throw new Error(overdueInvoices.error.message);

  // SQL evaluate_overdue no longer flips archived contracts to overdue, but
  // invoices already in overdue on an archived contract keep getting dunned.
  // Filter on the CONTRACT, not the tenant: one tenant may hold both an
  // archived and a live contract, and tenant-level suppression would silence
  // legitimate live arrears.
  const contractIds = [
    ...new Set(
      (overdueInvoices.data ?? [])
        .map((invoice) => invoice.contract_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const liveContracts =
    contractIds.length === 0
      ? { data: [] as Array<{ id: string }>, error: null }
      : await db.from("contracts").select("id").in("id", contractIds).is("archived_at", null);
  if (liveContracts.error) throw new Error(liveContracts.error.message);
  const liveContractIds = new Set((liveContracts.data ?? []).map((row) => row.id));

  const billableInvoices = (overdueInvoices.data ?? []).filter(
    (invoice) => invoice.contract_id != null && liveContractIds.has(invoice.contract_id),
  );

  const byTenant = new Map<string, { balance: number; oldestDue: string; invoiceIds: string[] }>();
  for (const invoice of billableInvoices) {
    const current = byTenant.get(invoice.tenant_id) ?? {
      balance: 0,
      oldestDue: invoice.due_date,
      invoiceIds: [],
    };
    current.balance += Number(invoice.balance);
    current.invoiceIds.push(invoice.id);
    if (invoice.due_date < current.oldestDue) current.oldestDue = invoice.due_date;
    byTenant.set(invoice.tenant_id, current);
  }

  const queued: string[] = [];
  const skipped: Array<{ tenant_id: string; reason: string }> = [];
  const origin = byTenant.size ? await companyOriginById(db, jobCompanyId) : "";
  for (const [tenantId, aggregate] of byTenant) {
    const tenantResult = await db.from("tenants").select("*").eq("id", tenantId).single();
    if (tenantResult.error || !tenantResult.data) continue;
    const tenant = tenantResult.data;
    if (!tenant.reminders_enabled) {
      skipped.push({ tenant_id: tenantId, reason: WHATSAPP_SKIP.remindersDisabled });
      continue;
    }

    // Idempotency: one overdue_reminder set per tenant per month
    const existing = await db
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("type", "overdue_reminder")
      .contains("payload", { month_key: monthKey })
      .neq("state", "cancelled")
      .limit(1);
    if (!existing.error && existing.data?.length) continue;

    // Tenant is block-level: off suppresses email AND WhatsApp for this job.
    if (!targets.includes("tenant")) {
      skipped.push({ tenant_id: tenantId, reason: WHATSAPP_SKIP.tenantNotTargeted });
      continue;
    }

    const locale = (tenant.preferred_language ?? "ar") as EmailLocale;
    const t = translatorFor(locale);
    const daysOverdue = Math.max(
      0,
      Math.floor(
        (new Date(asOfDate).getTime() - new Date(aggregate.oldestDue).getTime()) /
          (1000 * 60 * 60 * 24),
      ),
    );
    const outstanding = formatKwd(aggregate.balance, locale);
    const payNowUrl = portalInvoicesUrl(origin);
    const variables = {
      tenant_name: tenant.name,
      outstanding,
      days_overdue: String(daysOverdue),
      // Exposed as a variable so an admin-edited template can place the link
      // itself; the built-in template renders a button from the same value.
      pay_now_url: payNowUrl,
    };
    const templateCode = "overdue-reminder";
    const copy = await loadTemplateCopy(templateCode, locale, variables);
    const builtIn = overdueReminderTemplate({
      locale,
      tenantName: tenant.name,
      outstanding,
      daysOverdue,
      payNowUrl,
    });
    const subject = copy.subject ?? builtIn.subject;
    const body = copy.body ? renderEmailDocument(locale, subject, copy.body) : builtIn.html;
    // An admin template that never mentions the link would silently drop the
    // one thing this reminder exists to offer, and stripMarkup would delete an
    // anchor anyway — so append the bare URL unless the copy already carries it.
    const editedText = copy.body != null ? stripMarkup(copy.body) : null;
    const textBody =
      editedText == null
        ? builtIn.text
        : editedText.includes(payNowUrl)
          ? editedText
          : `${editedText}\n${t("portal.invoices.payNowAction")}: ${payNowUrl}`;
    // tenant_name is carried explicitly so a provider template can bind it as a
    // body parameter — WhatsApp templates read the payload, not the rendered body.
    const payload = {
      month_key: monthKey,
      tenant_name: tenant.name,
      outstanding,
      days_overdue: daysOverdue,
      invoice_ids: aggregate.invoiceIds,
      // Carried explicitly so an approved WhatsApp template can bind it as a
      // button/body parameter — those read the payload, never the rendered body.
      pay_now_url: payNowUrl,
    };

    // The template's channel decides which rows exist at all. Reading it here
    // rather than relying on the gate inside enqueueNotification keeps `queued`
    // honest — a dropped row must not be counted as one this job sent.
    if (tenant.email && templateAllowsChannel(copy.channel, "email")) {
      const emailRow = await enqueueNotification({
        type: "overdue_reminder",
        channel: "email",
        audience: "tenant",
        locale,
        tenantId,
        subject,
        body,
        recipientAddress: tenant.email,
        templateCode,
        payload: { ...payload, recipients: [tenant.email] },
      });
      if (emailRow) queued.push(emailRow.id);
    }

    const wa = tenant.whatsapp ?? tenant.mobile;
    if (!wa) skipped.push({ tenant_id: tenantId, reason: WHATSAPP_SKIP.noNumber });
    else if (!templateAllowsChannel(copy.channel, "whatsapp")) {
      skipped.push({ tenant_id: tenantId, reason: WHATSAPP_SKIP.templateExcludesChannel });
    } else {
      const waRow = await enqueueNotification({
        type: "overdue_reminder",
        channel: "whatsapp",
        audience: "tenant",
        locale,
        tenantId,
        subject: null,
        body: textBody,
        recipientAddress: wa,
        templateCode,
        payload,
      });
      if (waRow) queued.push(waRow.id);
    }
  }

  await db.rpc("write_audit", {
    p_action: "job.overdue_reminders",
    p_entity_type: "notification",
    p_entity_id: null,
    p_before: null,
    p_after: { as_of: asOfDate, month_key: monthKey, queued: queued.length, skipped },
    p_result: "success",
    p_error_code: null,
  });

  return { count: queued.length, notifications: queued, monthKey, skipped };
}
