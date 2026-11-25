import { createServerFn } from "@tanstack/react-start";
import PDFDocument from "pdfkit";
import { z } from "zod";

import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Company } from "@/hooks/useCompany";
import type { Locale } from "@/i18n/dictionary";
import {
  buildEmailBody,
  messageLabelsFor,
  resolveCompanyInfoBodies,
} from "@/lib/companyInfoMessage";
import { renderEmailDocument } from "@/lib/emailTemplates";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { requirePermission } from "@/fns/requirePermission";
import {
  fetchImageBuffer,
  layoutCompanyInfoPdf,
  type CompanyInfoPdfLabels,
} from "@/lib/companyInfoPdf";

/**
 * يرسل معلومات الشركة للمستأجر بالبريد و/أو واتساب، مع إرفاق ملف PDF.
 *
 * "Send Company Information" — guarded server fn that emails and/or WhatsApps
 * the company's contact + bank details to a tenant, with a server-rendered PDF
 * attached to the email.
 *
 * Mirrors `sendInvoiceToTenant`:
 *   - permission-gated via `has_permission('notifications.send')`
 *   - enqueues one notifications row per channel
 *   - both rows carry the PDF via the `attachment_paths` + `attachment_bucket`
 *     payload keys that `dispatchNotification.loadAttachments` reads. The
 *     email attaches it; under Evolution the WhatsApp row sends it as a
 *     document part after the text summary. Meta and Twilio builders ignore
 *     media, so under those providers the WhatsApp leg stays text-only and the
 *     only cost of the key is one unused download.
 */

/** Private bucket holding server-generated company documents (migration 49). */
const COMPANY_DOCUMENTS_BUCKET = "company-documents";

const schema = z.object({
  tenantId: z.string().uuid(),
  channels: z.array(z.enum(["email", "whatsapp"])).min(1),
  locale: z.enum(["ar", "en"]).optional(),
});

/**
 * Labels for the PDF attachment. Latin only, in every locale, and that is
 * deliberate: pdfkit's built-in fonts are WinAnsi-encoded and turn Arabic into
 * mojibake rather than text. See the font note in `src/lib/companyInfoPdf.ts`.
 * The Arabic wording still reaches the tenant in the message body below.
 */
const PDF_LABELS: CompanyInfoPdfLabels = {
  docTitle: "Company information",
  contactTitle: "Contact information",
  bankTitle: "Bank details",
  issuedOn: "Issued on",
  address: "Address",
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
  facebook: "Facebook",
  instagram: "Instagram",
  bankName: "Bank",
  iban: "IBAN",
  website: "Website",
};

/** Render the company-info PDF and return its bytes. */
async function renderCompanyInfoPdf(
  company: Company,
  labels: CompanyInfoPdfLabels = PDF_LABELS,
): Promise<Buffer> {
  const [companyLogo, bankLogo] = await Promise.all([
    company.logo_url ? fetchImageBuffer(company.logo_url) : Promise.resolve(null),
    company.bank_logo_url ? fetchImageBuffer(company.bank_logo_url) : Promise.resolve(null),
  ]);

  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
  const pageWidth = doc.page.width;
  const margin = doc.page.margins.left;

  layoutCompanyInfoPdf(doc, pageWidth, margin, company, labels, {
    company: companyLogo,
    bank: bankLogo,
  });

  doc.end();

  const chunks: Buffer[] = [];
  for await (const chunk of doc) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export const sendCompanyInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.send_company_info",
      refusal: "You do not have permission to send notifications.",
    });

    const [tenantRes, companyRes] = await Promise.all([
      supabaseAdmin
        .from("tenants")
        .select("id, name, name_en, email, whatsapp, mobile, preferred_language")
        .eq("id", data.tenantId)
        .single(),
      supabaseAdmin.from("companies").select("*").order("created_at").limit(1).maybeSingle(),
    ]);
    if (tenantRes.error || !tenantRes.data) {
      throw new Error(tenantRes.error?.message ?? "Tenant not found");
    }
    if (companyRes.error || !companyRes.data) {
      throw new Error(companyRes.error?.message ?? "Company not found");
    }
    const tenant = tenantRes.data;
    const company = companyRes.data as Company;

    const locale: Locale = (data.locale ?? tenant.preferred_language ?? "ar") as Locale;
    const labels = messageLabelsFor(locale);
    const portalUrl = process.env.PUBLIC_APP_URL
      ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, "")}/portal`
      : undefined;
    const companyDisplay =
      (locale === "ar" ? company.name_ar : company.name_en) ||
      company.name_en ||
      company.name_ar ||
      "";
    // The seed exists so this insert does not miss its FK, but the row is
    // also the Settings → Templates editor. Reading it here is what makes
    // an admin edit actually reach the tenant; a miss falls back to the
    // built-in builder the same way every other sender does.
    const copy = await loadTemplateCopy("company-info", locale, {
      tenant_name: tenantDisplayName(tenant, locale),
      company_name: companyDisplay,
    });
    const resolved = resolveCompanyInfoBodies(copy, labels, company, portalUrl, locale);
    const emailSubject = resolved.emailSubject;
    const emailBody = resolved.emailInnerBody
      ? renderEmailDocument(locale, emailSubject, resolved.emailInnerBody)
      : buildEmailBody(labels, company, portalUrl, locale);
    const waBody = resolved.waBody;

    // Render + upload the PDF once; reuse for every email channel.
    // Always Latin-labelled — see PDF_LABELS.
    const pdfBuffer = await renderCompanyInfoPdf(company, PDF_LABELS);
    const ts = Date.now();
    const objectPath = `company-info/${tenant.id}_${ts}.pdf`;
    // Private bucket (migration 49) — NOT `branding`, which migration 21 makes
    // world-readable to serve the logo anonymously. loadAttachments downloads
    // with the service-role client, so nothing here needs public read.
    const upload = await supabaseAdmin.storage
      .from(COMPANY_DOCUMENTS_BUCKET)
      .upload(objectPath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: false,
        cacheControl: "3600",
      });
    if (upload.error) throw new Error(upload.error.message);

    const inserted: string[] = [];

    for (const channel of data.channels) {
      const recipient = channel === "email" ? tenant.email : (tenant.whatsapp ?? tenant.mobile);
      if (!recipient) continue;

      if (channel === "email") {
        const row = await dispatchAndAudit(
          tenant.id,
          "email",
          locale,
          recipient,
          emailSubject,
          emailBody,
          "company-info",
          objectPath,
        );
        inserted.push(row);
      } else {
        const row = await dispatchAndAudit(
          tenant.id,
          "whatsapp",
          locale,
          recipient,
          null,
          waBody,
          "company-info",
          objectPath,
        );
        inserted.push(row);
      }
    }

    return { queued: inserted };
  });

/**
 * يُدرج صف إشعار من نوع `company_info` ويُرسله فوراً.
 *
 * Insert a notifications row of type `company_info` and dispatch it. Both
 * rows carry `attachment_paths` + `attachment_bucket` so
 * `dispatchNotification.loadAttachments` downloads the PDF for the provider.
 */
async function dispatchAndAudit(
  tenantId: string,
  channel: "email" | "whatsapp",
  locale: Locale,
  recipient: string,
  subject: string | null,
  body: string,
  templateCode: string,
  attachmentPath: string | null,
): Promise<string> {
  const insertResult = await supabaseAdmin
    .from("notifications")
    .insert({
      audience: "tenant",
      tenant_id: tenantId,
      type: "company_info",
      channel,
      locale,
      template_code: templateCode,
      subject,
      body,
      recipient_address: recipient,
      payload: {
        recipient,
        attachment_bucket: attachmentPath ? COMPANY_DOCUMENTS_BUCKET : undefined,
        attachment_paths: attachmentPath ? [attachmentPath] : [],
        template_key: "company_info",
      },
    })
    .select("*")
    .single();
  if (insertResult.error) throw new Error(insertResult.error.message);
  await dispatchNotificationRecord(insertResult.data.id);
  return insertResult.data.id;
}
