import type { SupabaseClient } from "@supabase/supabase-js";
import PDFDocument from "pdfkit";

import { companyClient } from "@/company/companyClient.server";
import { runWithRequestCompany } from "@/company/requestCompany.server";
import { companyStoragePath } from "@/company/storagePath";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { templateAllowsChannel } from "@/fns/templateChannelPolicy";
import type { Database, NotificationChannel } from "@/integrations/supabase/database.types";
import type { Company } from "@/hooks/useCompany";
import type { CompanyInfoChannel, JobPayload } from "@/jobs/catalog";
import { notificationDispatchDedupeKey } from "@/jobs/catalog";
import { enqueueJob } from "@/jobs/enqueue";
import type { Locale } from "@/i18n/dictionary";
import {
  buildEmailBody,
  messageLabelsFor,
  resolveCompanyInfoBodies,
} from "@/lib/companyInfoMessage";
import {
  fetchImageBuffer,
  layoutCompanyInfoPdf,
  type CompanyInfoPdfLabels,
} from "@/lib/companyInfoPdf";
import { renderEmailDocument } from "@/lib/emailTemplates";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/** Private bucket holding server-generated company documents (migration 49). */
const COMPANY_DOCUMENTS_BUCKET = "company-documents";

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

/**
 * اختيارات الموظف وقت الطلب: القنوات التي اختارها ولغة الإرسال.
 *
 * They travel in the job payload because the work happens after the request
 * is gone: without them the worker would send on every channel the renter has
 * a contact for, in the renter's preferred language, and the request's own
 * choices would be lost.
 */
export interface CompanyInfoSendChoice {
  channels: CompanyInfoChannel[];
  language: Locale;
}

/**
 * يرسل معلومات الشركة للمستأجر بالبريد و/أو واتساب، مع إرفاق ملف PDF.
 *
 * "Send Company Information" — the work moved out of the request so a PDF
 * render cannot hold the browser: the request now only enqueues, and this
 * function is what the `company.info.send` job runs (contracts/jobs.md
 * section 3).
 *
 * The rows carry the PDF via the `attachment_paths` + `attachment_bucket`
 * payload keys that `dispatchNotification.loadAttachments` reads. The email
 * attaches it; under Evolution the WhatsApp row sends it as a document part
 * after the text summary. Meta and Twilio builders ignore media, so under those
 * providers the WhatsApp leg stays text-only and the only cost of the key is
 * one unused download.
 *
 * The channels and the language come from the payload, so the job sends what
 * the staff member chose at request time. A channel the template forbids or the
 * renter has no contact for is dropped, exactly as the request used to drop it.
 */
export async function sendCompanyInformation(
  tenantId: string,
  companyId: string,
  choice: CompanyInfoSendChoice,
): Promise<{ notificationIds: string[] }> {
  const client = companyClient(companyId);

  const [tenantRes, companyRes] = await Promise.all([
    client
      .from("tenants")
      .select("id, name, name_en, email, whatsapp, mobile")
      .eq("id", tenantId)
      .single(),
    client.from("companies").select("*").eq("id", companyId).maybeSingle(),
  ]);
  if (tenantRes.error || !tenantRes.data) {
    throw new Error(tenantRes.error?.message ?? "Tenant not found");
  }
  if (companyRes.error || !companyRes.data) {
    throw new Error(companyRes.error?.message ?? "Company not found");
  }
  const tenant = tenantRes.data;
  const company = companyRes.data as Company;

  const locale: Locale = choice.language;
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
  const objectPath = companyStoragePath(companyId, `company-info/${tenant.id}_${ts}.pdf`);
  // Private bucket (migration 49) — NOT `branding`, which migration 21 makes
  // world-readable to serve the logo anonymously. loadAttachments downloads
  // with the company-scoped client, so nothing here needs public read.
  const upload = await client.storage.from(COMPANY_DOCUMENTS_BUCKET).upload(objectPath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: false,
    cacheControl: "3600",
  });
  if (upload.error) throw new Error(upload.error.message);

  const inserted: string[] = [];

  const deliveries = companyInfoDeliveries(choice.channels, copy.channel, tenant);

  for (const delivery of deliveries) {
    const { channel, recipient } = delivery;

    const notificationId = await insertCompanyInfoRow(client, {
      attachmentPath: objectPath,
      body: channel === "email" ? emailBody : waBody,
      channel,
      companyId,
      locale,
      recipient,
      subject: channel === "email" ? emailSubject : null,
      tenantId: tenant.id,
    });
    inserted.push(notificationId);
    // The delivery is left to the notify worker: the row is written `queued`
    // and the worker sends it, so a provider that is down cannot fail the
    // request that asked for the document (contracts/jobs.md section 1).
    await enqueueJob(
      client,
      "notification.dispatch",
      { notificationId },
      { dedupeKey: notificationDispatchDedupeKey(notificationId) },
    );
  }

  return { notificationIds: inserted };
}

/** جهات اتصال المستأجر التي يقرأ منها المرسِل عنوان القناة المطلوبة. */
interface TenantContacts {
  email: string | null;
  mobile: string | null;
  whatsapp: string | null;
}

/**
 * يختار القنوات التي تصل فعلاً: ما اختاره المسؤول، بلا قناة لا يسمح بها
 * القالب، ولا قناة بلا جهة اتصال لدى المستأجر.
 *
 * A channel the admin ticked but the renter has no contact for is dropped, not
 * failed: the request already refused a tenant with no contact on any of the
 * chosen channels, and one missing contact must not cost the other channel.
 */
function companyInfoDeliveries(
  channels: CompanyInfoChannel[],
  templateChannel: NotificationChannel | null,
  tenant: TenantContacts,
): Array<{ channel: CompanyInfoChannel; recipient: string }> {
  const deliveries: Array<{ channel: CompanyInfoChannel; recipient: string }> = [];
  for (const channel of channels) {
    const recipient = channel === "email" ? tenant.email : (tenant.whatsapp ?? tenant.mobile);
    if (!recipient) continue;
    if (!templateAllowsChannel(templateChannel, channel)) continue;
    deliveries.push({ channel, recipient });
  }
  return deliveries;
}

/** صف الإشعار الذي سيحمل ملف معلومات الشركة. */
interface CompanyInfoRow {
  attachmentPath: string;
  body: string;
  channel: CompanyInfoChannel;
  companyId: string;
  locale: Locale;
  recipient: string;
  subject: string | null;
  tenantId: string;
}

/**
 * يُدرج صف إشعار من نوع `company_info` يحمل ملف PDF المرفق.
 *
 * The row is written `queued`; the notify worker picks it up and delivers it,
 * which is also where the tenant's pause switch is honoured.
 */
async function insertCompanyInfoRow(
  client: SupabaseClient<Database>,
  row: CompanyInfoRow,
): Promise<string> {
  const insertResult = await client
    .from("notifications")
    .insert({
      company_id: row.companyId,
      audience: "tenant",
      tenant_id: row.tenantId,
      type: "company_info",
      channel: row.channel,
      locale: row.locale,
      template_code: "company-info",
      subject: row.subject,
      body: row.body,
      recipient_address: row.recipient,
      payload: {
        recipient: row.recipient,
        attachment_bucket: COMPANY_DOCUMENTS_BUCKET,
        attachment_paths: [row.attachmentPath],
        template_key: "company_info",
      },
    })
    .select("*")
    .single();
  if (insertResult.error) throw new Error(insertResult.error.message);
  return insertResult.data.id;
}

/**
 * يبني معالج مهمة `company.info.send`: يرسل معلومات الشركة ثم يترك الإرسال لعامل الإشعارات.
 *
 * The dispatch runs inside the job's own company context because the template
 * copy and the company letterhead are read through the request company, and a
 * background job has no request.
 */
export function createCompanyInfoSendHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { tenantId, channels, language } = ctx.payload as JobPayload<"company.info.send">;
    const result = await runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      () => sendCompanyInformation(tenantId, ctx.companyId, { channels, language }),
    );
    return { tenantId, channels, language, notificationIds: result.notificationIds };
  };
}
