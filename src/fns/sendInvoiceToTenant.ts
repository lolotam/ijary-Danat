import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { joinLocalizedList } from "@/lib/contractUnits";
import { formatIsoMonthYear, formatMonthYear } from "@/lib/dateDisplay";
import {
  invoiceDocumentTemplate,
  renderEmailDocument,
  type EmailLocale,
} from "@/lib/emailTemplates";
import { hasDiscount } from "@/lib/invoiceDiscountBadge";
import { renderInvoiceDocumentPdf } from "@/lib/invoiceDocumentPdf";
import { formatKwd } from "@/lib/money";
import { invoiceSendRowBucket, type InvoiceSendOutcome } from "@/lib/invoiceSendOutcome";
import { attachmentPayload } from "@/lib/reportPdfAttachment";
import { stripMarkup } from "@/lib/templateRender";
import { TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";
import { requirePermission } from "@/fns/requirePermission";

/**
 * يرسل فاتورة واحدة إلى مستأجرها فور الطلب عبر البريد و/أو واتساب.
 *
 * Mirrors sendTenantCredentials: guarded server fn that enqueues one
 * notifications row per channel and dispatches through the provider pipeline.
 * The email carries the full invoice (same fields as the printable
 * InvoicePrint sheet); WhatsApp carries the text summary. When the invoice
 * sheet renders to a PDF, BOTH channels carry it as an attachment — the
 * dispatcher downloads from `attachment_bucket` and, under Evolution, sends it
 * as a WhatsApp document; under Meta/Twilio the key is ignored and the text
 * still goes out. No deliveryKey is set so an admin can re-send the same
 * invoice as many times as needed.
 *
 * Under Evolution the WhatsApp row goes out as free text. Under Meta or Twilio
 * it only delivers once an approved provider template is mapped on the
 * `invoice-document` template row (migration 38); until then the dispatcher
 * records the row and marks it failed with the missing-mapping reason.
 *
 * Returns IDs grouped by dispatch state: `sent` was accepted, `queued` is
 * still pending, `failed` did not complete, and `refused` never created a row
 * (channel policy or missing contact). `paused` names the channels whose row
 * was skipped because this tenant's notifications are paused — a channel the
 * owner asked to silence, not a channel that failed.
 */

const schema = z.object({
  invoiceId: z.string().uuid(),
  channels: z.array(z.enum(["email", "whatsapp"])).min(1),
  locale: z.enum(["ar", "en"]).optional(),
});

export const sendInvoiceToTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.update",
      attempted: "invoice.send_to_tenant",
      refusal: "You do not have permission to update an invoice.",
    });

    const companyRecord = requireRequestCompany();
    const db = companyClient(companyRecord.id);

    const invoiceRes = await db.from("invoices").select("*").eq("id", data.invoiceId).single();
    if (invoiceRes.error || !invoiceRes.data) {
      throw new Error(invoiceRes.error?.message ?? "Invoice not found");
    }
    const invoice = invoiceRes.data;

    const [tenantRes, itemsRes] = await Promise.all([
      db
        .from("tenants")
        .select("id, name, email, whatsapp, mobile, preferred_language")
        .eq("id", invoice.tenant_id)
        .single(),
      // invoice.unit_id is null for a consolidated multi-unit invoice
      // (migration 112) — the rent lines on invoice_items carry the per-unit
      // attribution instead, so every unit the invoice covers is resolved from
      // there rather than from the invoice's own (possibly absent) unit_id.
      db
        .from("invoice_items")
        .select("unit_id")
        .eq("invoice_id", invoice.id)
        .not("unit_id", "is", null),
    ]);
    if (tenantRes.error || !tenantRes.data) {
      throw new Error(tenantRes.error?.message ?? "Tenant not found");
    }
    if (itemsRes.error) throw new Error(itemsRes.error.message);
    const tenant = tenantRes.data;
    const unitIds = [
      ...new Set(itemsRes.data.map((row) => row.unit_id).filter((id): id is string => id != null)),
    ];
    const unitsRes = unitIds.length
      ? await db.from("units").select("id, name, property_id").in("id", unitIds)
      : {
          data: [] as Array<{ id: string; name: string; property_id: string | null }>,
          error: null,
        };
    if (unitsRes.error) throw new Error(unitsRes.error.message);
    const units = unitsRes.data;

    const propertyIds = [
      ...new Set(units.map((unit) => unit.property_id).filter((id): id is string => id != null)),
    ];
    const [propertiesRes, companyRes] = await Promise.all([
      propertyIds.length
        ? db.from("properties").select("id, name_ar, name_en").in("id", propertyIds)
        : Promise.resolve({
            data: [] as Array<{ id: string; name_ar: string; name_en: string | null }>,
            error: null,
          }),
      db
        .from("companies")
        .select("name_ar, name_en, invoice_footer_ar, invoice_footer_en")
        .eq("id", companyRecord.id)
        .maybeSingle(),
    ]);
    if (propertiesRes.error) throw new Error(propertiesRes.error.message);
    const properties = propertiesRes.data;
    const company = companyRes.data;

    const locale: EmailLocale = (data.locale ?? tenant.preferred_language ?? "ar") as EmailLocale;

    const portalUrl = process.env.PUBLIC_APP_URL
      ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/portal`
      : undefined;

    // Every unit the invoice covers, not just the first — a consolidated
    // invoice has no single unit to name.
    const unitName = units.length
      ? joinLocalizedList(
          units.map((unit) => unit.name),
          locale,
        )
      : "—";
    const propertyLabels = [
      ...new Set(
        properties.map(
          (property) => (locale === "ar" ? property.name_ar : property.name_en) ?? "—",
        ),
      ),
    ];
    const propertyName = propertyLabels.length ? joinLocalizedList(propertyLabels, locale) : "—";
    const period = formatMonthYear(invoice.period_month, invoice.period_year, locale);
    const footer =
      (locale === "ar" ? company?.invoice_footer_ar : company?.invoice_footer_en) ?? "";
    // No discount means the two rows are withheld everywhere at once: the
    // stored body hides them behind a {{#has_discount}} section (migration
    // 201) keyed on a separate flag, so `subtotal` and `discount` stay
    // formatted and an UNWRAPPED body renders exactly as it always did; the
    // built-in template gets null (rows omitted).
    const discounted = hasDiscount(invoice.discount);
    const variables = {
      tenant_name: tenant.name,
      unit_name: unitName,
      property_name: propertyName,
      invoice_number: invoice.code,
      period,
      issue_date: invoice.issue_date,
      due_date: formatIsoMonthYear(invoice.due_date, locale),
      subtotal: formatKwd(invoice.subtotal, locale),
      discount: formatKwd(invoice.discount, locale),
      has_discount: discounted ? "1" : "",
      paid: formatKwd(invoice.paid, locale),
      total: formatKwd(invoice.total, locale),
      footer,
    };
    const templateCode = "invoice-document";
    const copy = await loadTemplateCopy(templateCode, locale, variables);
    const builtIn = invoiceDocumentTemplate({
      locale,
      tenantName: tenant.name,
      unitName,
      propertyName,
      invoiceNumber: invoice.code,
      period,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      subtotal: formatKwd(invoice.subtotal, locale),
      discount: discounted ? formatKwd(invoice.discount, locale) : null,
      paid: formatKwd(invoice.paid, locale),
      total: formatKwd(invoice.total, locale),
      footer: footer || null,
      payUrl: portalUrl,
    });
    const subject = copy.subject ?? builtIn.subject;
    const htmlBody = copy.body ? renderEmailDocument(locale, subject, copy.body) : builtIn.html;
    const textBody = copy.body != null ? stripMarkup(copy.body) : builtIn.text;

    // Rendered once, before the loop: both channels attach the same document,
    // and a null (any failure inside is logged there) degrades the send to
    // text only rather than blocking it.
    const pdf = await renderInvoiceDocumentPdf({ invoice, locale });
    const attachments = attachmentPayload(pdf, pdf ? [pdf.displayName] : undefined);

    const outcome: InvoiceSendOutcome = {
      sent: [],
      queued: [],
      failed: [],
      refused: [],
      paused: [],
      pdfMissing: pdf === null,
    };

    for (const channel of data.channels) {
      const recipient = channel === "email" ? tenant.email : (tenant.whatsapp ?? tenant.mobile);
      if (!recipient) {
        outcome.refused.push(channel);
        continue;
      }

      const row = await enqueueNotification({
        type: "document_send",
        channel,
        audience: "tenant",
        locale,
        tenantId: tenant.id,
        invoiceId: invoice.id,
        subject: channel === "email" ? subject : null,
        body: channel === "email" ? htmlBody : textBody,
        recipientAddress: recipient,
        templateCode,
        // A WhatsApp template binds payload keys, so carry every value the
        // summary names in case a provider mapping is added later.
        payload: {
          recipient,
          template_key: "invoice_document",
          invoice_code: invoice.code,
          period,
          total: formatKwd(invoice.total, locale),
          due_date: invoice.due_date,
          tenant_name: tenant.name,
          ...attachments,
          // Marks a text-only send on the row itself, so the Notification Log
          // shows the missing PDF instead of it passing for a complete send.
          ...(pdf ? {} : { attachment_missing: [invoice.code] }),
        },
      });
      // A channel the admin ticked here is still refused when the template
      // excludes it or the tenant has no address — a dialog checkbox is
      // presentation, not a control. The allowed channels still go out, so
      // ticking both is not an all-or-nothing failure.
      //
      // The returned row already carries the post-dispatch `state`. Putting its
      // id in `queued` regardless used to toast "Invoice sent" for a row that
      // never completed (PR #214).
      if (!row) {
        outcome.refused.push(channel);
        continue;
      }
      // A paused tenant is not a failed send: the owner asked for nothing to
      // reach this tenant, so the row was born `skipped` with the pause reason.
      // Reporting it as a failure would send the admin looking for a broken
      // template instead of the switch they flipped.
      if (row.state === "skipped" && row.failure_reason === TENANT_PAUSED_REASON) {
        outcome.paused?.push(channel);
        continue;
      }
      outcome[invoiceSendRowBucket(row.state)].push(row.id);
    }

    return outcome;
  });
