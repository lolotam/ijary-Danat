import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { serverCompanyClient } from "@/company/companyClient.server";
import { companyStoragePath } from "@/company/storagePath";
import type { Database } from "@/integrations/supabase/database.types";
import { renderHtmlToPdf, wrapHtmlForPdf } from "@/lib/serverPdf";

/**
 * Render an emailed document to PDF and store it for the mail dispatcher.
 *
 * `serverPdf.ts` has existed, tested and complete, since the server-PDF change
 * — and nothing in production ever called it, so every emailed report went out
 * as HTML only. This is the missing wiring.
 *
 * The PDF is uploaded rather than attached inline because `dispatchNotification`
 * already loads attachments from `payload.attachment_paths` +
 * `payload.attachment_bucket`. Reusing that path means no second attachment
 * mechanism, a resend that costs no re-render, and a durable copy of exactly
 * what a recipient was sent.
 *
 * Rendering goes through Chromium against the *same* HTML the email body uses,
 * so the PDF matches the email by construction rather than by a parallel
 * template someone has to remember to update. `wrapHtmlForPdf` supplies A4 page
 * geometry and the Arabic-safe font stack, and passes a full `<!doctype>`
 * document through untouched.
 */
export const REPORT_DOCUMENTS_BUCKET = "report-documents";

export type StoredPdf = { bucket: string; path: string };

/** Storage keys must be ASCII-safe; report names may be Arabic. */
function safeKeySegment(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "document";
}

/**
 * بصمة قصيرة لمحتوى المستند، تجعل مسار التخزين معتمِدًا على المحتوى نفسه.
 *
 * Content-addressing is what makes reuse *safe*. Keying on identity alone —
 * a payment id, a report period — would mean a second send reuses whatever was
 * stored first, so a receipt first rendered in English, or before a manual
 * payment reason existed, would be served forever after. Hashing the finished
 * document instead makes any change of locale, reason, amount or letterhead
 * land on a different key and render fresh, with no caller left to reason about
 * which of its inputs affect the output.
 *
 * Twelve hex characters is 48 bits. These documents are counted in hundreds.
 */
function contentFingerprint(printableHtml: string): string {
  return createHash("sha256").update(printableHtml, "utf8").digest("hex").slice(0, 12);
}

/**
 * هل الملف مخزَّن فعلًا تحت هذا المسار؟
 *
 * A failed probe answers "no" so the caller renders: spending a Chromium run we
 * did not need is a wasted couple of seconds, while wrongly reporting a hit
 * would attach a document that does not exist.
 */
async function storedAlready(client: SupabaseClient<Database>, path: string): Promise<boolean> {
  const separator = path.lastIndexOf("/");
  const folder = path.slice(0, separator);
  const objectName = path.slice(separator + 1);

  const listing = await client.storage
    .from(REPORT_DOCUMENTS_BUCKET)
    .list(folder, { search: objectName, limit: 100 });
  if (listing.error) {
    console.error("[reportPdfAttachment] lookup failed", path, listing.error.message);
    return false;
  }
  // `search` narrows the listing, it does not identify an object; the exact
  // name is what says this file — and only this file — is already stored.
  return listing.data.some((entry) => entry.name === objectName);
}

/**
 * يحوّل HTML إلى PDF ويخزّنه تحت مسار الشركة `companies/<companyId>/<prefix>/<name>-<discriminator>-<hash>.pdf`.
 *
 * Returns `null` rather than throwing when rendering or upload fails. A report
 * whose PDF could not be produced must still reach its recipients as HTML —
 * losing the attachment is a degradation, losing the report is an outage. The
 * caller logs; every failure here is reported, never silent.
 */
export async function renderAndStorePdf(input: {
  arabic: boolean;
  companyId?: string;
  discriminator: string;
  html: string;
  name: string;
  prefix: string;
}): Promise<StoredPdf | null> {
  const { companyId, client } = serverCompanyClient(input.companyId);
  const printableHtml = wrapHtmlForPdf(input.html, { arabic: input.arabic });
  const path = companyStoragePath(
    companyId,
    `${safeKeySegment(input.prefix)}/${safeKeySegment(input.name)}-${safeKeySegment(
      input.discriminator,
    )}-${contentFingerprint(printableHtml)}.pdf`,
  );

  try {
    if (await storedAlready(client, path)) {
      return { bucket: REPORT_DOCUMENTS_BUCKET, path };
    }

    const pdf = await renderHtmlToPdf(printableHtml);
    const upload = await client.storage
      .from(REPORT_DOCUMENTS_BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upload.error) {
      console.error("[reportPdfAttachment] upload failed", path, upload.error.message);
      return null;
    }
    return { bucket: REPORT_DOCUMENTS_BUCKET, path };
  } catch (error) {
    // Chromium missing from the image, or a render timeout. Both are real and
    // both must be visible: an emailed report that quietly loses its attachment
    // looks identical to one that never had it configured.
    console.error(
      "[reportPdfAttachment] render failed",
      path,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Payload fields `dispatchNotification.loadAttachments` reads, or `{}`.
 *
 * Accepts a list because one notification can carry several documents — a
 * multi-month payment link settles several payments at once and each gets its
 * own receipt. `loadAttachments` reads a single `attachment_bucket` for every
 * path, so the whole list must live in one bucket; both callers store under
 * `report-documents`.
 *
 * `displayNames` renames the files the recipient sees without touching the
 * storage keys. A stored path ends in its own discriminator and content hash so
 * a re-render overwrites itself instead of littering the bucket, and that key is
 * unreadable as a filename. Receipts pass the receipt code here; scheduled
 * reports pass nothing and keep their descriptive stored names. Names are used
 * only when there is exactly one non-empty name per document, so a partial list
 * can never shift a name onto the wrong file.
 */
export function attachmentPayload(
  stored: StoredPdf | StoredPdf[] | null,
  displayNames?: readonly string[],
): Record<string, unknown> {
  const documents = Array.isArray(stored) ? stored : stored ? [stored] : [];
  if (!documents.length) return {};
  const names = (displayNames ?? []).slice(0, documents.length);
  return {
    attachment_bucket: documents[0].bucket,
    attachment_paths: documents.map((document) => document.path),
    ...(names.length === documents.length && names.every(Boolean)
      ? { attachment_names: names }
      : {}),
  };
}
