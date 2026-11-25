import { toast } from "sonner";

import type { TenantDocument } from "@/hooks/useTenants";
import { createTenantDocumentSignedUrl } from "@/hooks/useTenants";

export interface DownloadZipOptions {
  /** Tenant identifier (used in the filename). */
  tenantId: string;
  /** Optional tenant code/name to use in the filename (more readable). */
  tenantLabel?: string;
  /** i18n-aware toast labels. */
  labels?: {
    preparing?: string;
    ready?: string;
    failed?: string;
  };
}

async function fetchAsArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}

/**
 * Display names are user-entered ("Civil ID") and often carry no extension, while the
 * stored object always does. Borrow the stored extension so ZIP entries stay openable.
 */
function entryName(doc: TenantDocument): string {
  const display = (doc.display_name ?? "").trim() || "document";
  if (/\.[a-z0-9]{1,8}$/i.test(display)) return display;
  const storedExtension = doc.storage_path
    .split("/")
    .pop()
    ?.match(/\.[a-z0-9]{1,8}$/i)?.[0];
  return storedExtension ? `${display}${storedExtension}` : display;
}

function dedupeName(rawName: string, used: Set<string>): string {
  const base = rawName || "document";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 1;
  let candidate = `${stem} (${n})${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export async function downloadTenantDocumentsZip(
  docs: TenantDocument[],
  options: DownloadZipOptions,
): Promise<void> {
  if (!docs.length) return;
  const { tenantLabel, tenantId, labels } = options;
  const usedNames = new Set<string>();
  const toastId = toast.loading(labels?.preparing ?? "Preparing ZIP…");

  try {
    // Loaded on demand — JSZip is ~95 KB gzipped and only bulk download needs it.
    const [{ default: JSZip }, { saveAs }] = await Promise.all([
      import("jszip"),
      import("file-saver"),
    ]);
    const zip = new JSZip();
    let added = 0;
    for (const doc of docs) {
      try {
        const signedUrl = await createTenantDocumentSignedUrl(doc.storage_path);
        const buf = await fetchAsArrayBuffer(signedUrl);
        zip.file(dedupeName(entryName(doc), usedNames), buf);
        added += 1;
      } catch {
        // Skip files that fail to fetch but keep going.
      }
    }
    if (!added) throw new Error(labels?.failed ?? "No documents could be downloaded.");
    const blob = await zip.generateAsync({ type: "blob" });
    const safeLabel = (tenantLabel ?? tenantId).replace(/[^\w-]+/g, "_");
    saveAs(blob, `tenant-${safeLabel}-documents.zip`);
    toast.success(labels?.ready ?? "ZIP downloaded", { id: toastId });
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : (labels?.failed ?? "Failed to build ZIP"),
      { id: toastId },
    );
  }
}
