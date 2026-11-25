import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import { useDocumentErrorDescription } from "@/components/admin/tenant-documents/documentErrors";
import { TENANT_DOCUMENT_TYPES } from "@/components/admin/tenant-documents/documentTypes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TENANT_DOCUMENT_MAX_MB, useUploadTenantDocument } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import type { TenantDocumentType } from "@/integrations/supabase/database.types";

/**
 * صف رفع وثيقة: النوع، الاسم المعروض، واختيار الملف الذي يبدأ الرفع فوراً.
 *
 * `contractId` tags the upload to one contract when the manager is scoped to
 * it; omitted, the document is tenant-wide.
 */
export function TenantDocumentUploadRow({
  tenantId,
  companyId,
  contractId,
  canEdit,
}: {
  tenantId: string;
  companyId: string | null;
  contractId: string | null;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const upload = useUploadTenantDocument();
  const describeError = useDocumentErrorDescription();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadType, setUploadType] = useState<TenantDocumentType>("civil_id");
  const [uploadName, setUploadName] = useState("");

  /** يرفع الملف المختار بالنوع والاسم الحاليين، ثم يفرّغ الحقلين. */
  async function handleUploadFile(file: File | null) {
    if (!file || !companyId) return;
    try {
      await upload.mutateAsync({
        tenantId,
        companyId,
        file,
        type: uploadType,
        displayName: uploadName.trim() || file.name,
        contractId,
      });
      setUploadName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast.success(t("documents.uploaded"));
    } catch (error) {
      toast.error(t("documents.uploadError"), { description: describeError(error) });
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[160px_1fr_auto]">
      <div>
        <Label>{t("documents.type")}</Label>
        <Select
          value={uploadType}
          disabled={!canEdit}
          onValueChange={(v) => setUploadType(v as TenantDocumentType)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TENANT_DOCUMENT_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`documentType.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`tenant-doc-name-${tenantId}`}>{t("documents.displayName")}</Label>
        <Input
          id={`tenant-doc-name-${tenantId}`}
          value={uploadName}
          placeholder={t("documents.displayNamePlaceholder")}
          onChange={(e) => setUploadName(e.target.value)}
        />
      </div>
      <div className="flex items-end">
        <input
          ref={fileInputRef}
          id={`tenant-doc-file-${tenantId}`}
          type="file"
          accept="image/*,.pdf"
          className="sr-only"
          disabled={!canEdit || !companyId || upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            void handleUploadFile(file);
          }}
        />
        <Button
          type="button"
          className="w-full sm:w-auto"
          disabled={!canEdit || !companyId || upload.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-4" />
          {upload.isPending ? t("common.loading") : t("documents.upload")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-3">
        {t("documents.pickHint").replace("{{size}}", String(TENANT_DOCUMENT_MAX_MB))}
      </p>
    </div>
  );
}
