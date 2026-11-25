import {
  TENANT_DOCUMENT_MAX_MB,
  TENANT_DOCUMENT_TOO_LARGE,
  TENANT_DOCUMENT_UNSUPPORTED_TYPE,
} from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { STORAGE_UPLOAD_CONNECTION_FAILED, STORAGE_UPLOAD_TIMED_OUT } from "@/lib/uploadLimits";

/**
 * يعيد دالة تحوّل أخطاء رفع المستند إلى نص مترجم، وتُبقي رسائل التخزين الأخرى كما هي.
 *
 * Shared by the upload row and the edit dialog, which both upload a file and
 * must explain the same four validation failures the same way — a size limit
 * the operator can act on, not a raw error code.
 */
export function useDocumentErrorDescription(): (error: unknown) => string | undefined {
  const { t } = useI18n();
  const tooLarge = t("documents.tooLarge").replace("{{size}}", String(TENANT_DOCUMENT_MAX_MB));
  const unsupportedType = t("documents.unsupportedType");
  const timedOut = t("documents.uploadTimedOut");
  const connectionFailed = t("documents.uploadConnectionFailed");
  return (error) => {
    if (!(error instanceof Error)) return undefined;
    if (error.message === TENANT_DOCUMENT_TOO_LARGE) return tooLarge;
    if (error.message === TENANT_DOCUMENT_UNSUPPORTED_TYPE) return unsupportedType;
    if (error.message === STORAGE_UPLOAD_TIMED_OUT) return timedOut;
    if (error.message === STORAGE_UPLOAD_CONNECTION_FAILED) return connectionFailed;
    return error.message;
  };
}
