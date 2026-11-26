import { CompanyContextError } from "@/company/errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPANY_PREFIX_PATTERN =
  /^companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(.*))?$/i;

/**
 * يتحقق من أن معرّف الشركة نص UUID صالح، وإلا يرمي خطأ سياق الشركة COMPANY_REQUIRED.
 */
export function assertStorageCompanyId(companyId: string | null | undefined): string {
  if (typeof companyId !== "string" || !UUID_PATTERN.test(companyId)) {
    throw new CompanyContextError("COMPANY_REQUIRED");
  }
  return companyId;
}

/**
 * يستخرج معرّف الشركة من مسار تخزين يبدأ بـ `companies/<companyId>/`، أو يعيد null.
 */
export function extractCompanyIdFromStoragePath(
  storagePath: string | null | undefined,
): string | null {
  if (!storagePath) return null;
  const trimmed = storagePath.replace(/^\/+/, "");
  const match = COMPANY_PREFIX_PATTERN.exec(trimmed);
  return match?.[1] ?? null;
}

/**
 * يبني مسار تخزين معزولاً للشركة بصيغة `companies/<companyId>/<relativePath>`.
 *
 * Rejects missing/invalid company ids, traversal segments (`..`), and paths
 * already prefixed for a different company so every bucket stays isolated by
 * `304_storage_company_paths.sql`.
 */
export function companyStoragePath(companyId: string, relativePath: string): string {
  // Storage policies compare the folder to `current_company_id()::text`, which
  // Postgres always renders lowercase; an uppercase id would be refused.
  const validCompanyId = assertStorageCompanyId(companyId).toLowerCase();
  const cleaned = relativePath.replace(/^\/+/, "");
  if (!cleaned) {
    throw new Error("Storage relative path is required");
  }

  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid storage path traversal segment");
  }

  if (segments[0] === "companies") {
    const existingCompanyId = segments[1];
    if (!existingCompanyId || existingCompanyId.toLowerCase() !== validCompanyId) {
      throw new Error("Cross-company storage path rejected");
    }
    if (segments.length < 3) {
      throw new Error("Storage relative path is required");
    }
    return `companies/${validCompanyId}/${segments.slice(2).join("/")}`;
  }

  return `companies/${validCompanyId}/${segments.join("/")}`;
}
