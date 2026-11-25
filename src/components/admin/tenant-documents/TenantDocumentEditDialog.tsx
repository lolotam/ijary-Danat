import { toast } from "sonner";

import { useDocumentErrorDescription } from "@/components/admin/tenant-documents/documentErrors";
import { TENANT_DOCUMENT_TYPES } from "@/components/admin/tenant-documents/documentTypes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useUpdateTenantDocument,
  type TenantDocument,
  type TenantDocumentUpdateInput,
} from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { type DocumentEditState } from "@/components/admin/tenant-documents/documentEditState";
import type { TenantDocumentType } from "@/integrations/supabase/database.types";

/**
 * حوار تعديل وثيقة: الاسم والنوع، واستبدال الملف اختيارياً.
 *
 * Picking no new file saves in "keep" mode, which leaves the stored object
 * untouched; only an actual file switches to "replace".
 */
export function TenantDocumentEditDialog({
  state,
  onStateChange,
}: {
  state: DocumentEditState | null;
  onStateChange: (next: DocumentEditState | null) => void;
}) {
  const { t } = useI18n();
  const update = useUpdateTenantDocument();
  const describeError = useDocumentErrorDescription();

  /** يحفظ التعديل ويغلق الحوار عند النجاح فقط. */
  async function saveEdit() {
    if (!state) return;
    const payload: TenantDocumentUpdateInput =
      state.mode === "replace" && state.file
        ? {
            mode: "replace",
            id: state.document.id,
            file: state.file,
            displayName: state.displayName.trim() || undefined,
            type: state.type,
          }
        : {
            mode: "keep",
            id: state.document.id,
            displayName: state.displayName.trim() || undefined,
            type: state.type,
          };
    try {
      await update.mutateAsync(payload);
      onStateChange(null);
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(describeError(error) ?? t("common.error"));
    }
  }

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onStateChange(null)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("documents.editTitle")}</DialogTitle>
          <DialogDescription>{t("documents.editDescription")}</DialogDescription>
        </DialogHeader>
        {state ? (
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="doc-edit-name">{t("documents.displayName")}</Label>
              <Input
                id="doc-edit-name"
                value={state.displayName}
                onChange={(e) => onStateChange({ ...state, displayName: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("documents.type")}</Label>
              <Select
                value={state.type}
                onValueChange={(v) => onStateChange({ ...state, type: v as TenantDocumentType })}
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
            <div className="grid gap-2">
              <Label htmlFor="doc-edit-file">{t("documents.replaceFile")}</Label>
              <Input
                id="doc-edit-file"
                type="file"
                accept="image/*,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? undefined;
                  onStateChange({ ...state, file: f, mode: f ? "replace" : "keep" });
                }}
              />
              {state.file ? (
                <p className="text-xs text-muted-foreground">
                  {t("documents.newAttachmentSelected")} · {(state.file.size / 1024).toFixed(0)} KB
                </p>
              ) : state.document.storage_path ? (
                <p className="text-xs text-muted-foreground">
                  {t("documents.currentAttachmentKept")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onStateChange(null)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={saveEdit} disabled={update.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
