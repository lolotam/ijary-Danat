import { createTenantDocumentSignedUrl } from "@/hooks/useTenants";
import type { TenantDocument } from "@/hooks/useTenants";

export interface DocLink {
  name: string;
  url: string;
}

export async function resolveDocLinks(docs: TenantDocument[]): Promise<DocLink[]> {
  const links: DocLink[] = [];
  for (const doc of docs) {
    try {
      const url = await createTenantDocumentSignedUrl(doc.storage_path);
      links.push({ name: doc.display_name ?? doc.id, url });
    } catch {
      // Skip documents that fail to resolve (e.g., missing in storage).
    }
  }
  return links;
}

export const KUWAIT_PHONE_ERROR = "Invalid Kuwait phone — use +965 8 digits or 8 digits only";

export type PhoneNormalizeResult = { ok: true; digits: string } | { ok: false; error: string };

/** Accept only Kuwait numbers: bare 8 digits, or 965 + 8 digits (with optional +). */
export function normalizePhone(raw: string): PhoneNormalizeResult {
  const digits = raw.trim().replace(/[^\d]/g, "");
  if (/^\d{8}$/.test(digits)) {
    return { ok: true, digits: `965${digits}` };
  }
  if (/^965\d{8}$/.test(digits)) {
    return { ok: true, digits };
  }
  return { ok: false, error: KUWAIT_PHONE_ERROR };
}

/**
 * Message copy is passed in rather than hardcoded — recipients are tenants who may
 * read Arabic, so the caller supplies text in the active locale.
 */
export interface ShareMessageLabels {
  intro: string;
  expiryNote: string;
}

function messageBody(links: DocLink[], labels: ShareMessageLabels): string {
  return [labels.intro, ...links.map((l) => `• ${l.name}: ${l.url}`), "", labels.expiryNote].join(
    "\n",
  );
}

export function buildWhatsAppUrl(
  phone: string,
  links: DocLink[],
  labels: ShareMessageLabels,
): string {
  const result = normalizePhone(phone);
  if (!result.ok) throw new Error(result.error);
  const params = new URLSearchParams({ text: messageBody(links, labels) });
  return `https://wa.me/${result.digits}?${params.toString()}`;
}

export function buildMailtoUrl(
  email: string,
  subject: string,
  links: DocLink[],
  labels: ShareMessageLabels,
): string {
  const params = new URLSearchParams({ subject, body: messageBody(links, labels) });
  return `mailto:${email}?${params.toString()}`;
}
