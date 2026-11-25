import { useMemo, useState } from "react";
import { LayoutGrid, Share2, Table as TableIcon, Upload } from "lucide-react";
import { toast } from "sonner";

import { AttachmentPreviewDialog } from "@/components/admin/AttachmentPreviewDialog";
import { DeleteConfirmation, TableState } from "@/components/admin/Phase2Ui";
import {
  TenantDocumentsBulkBar,
  TenantDocumentShareDialogs,
  useShareDialogState,
} from "@/components/admin/TenantDocumentShareDialogs";
import {
  editStateFor,
  type DocumentEditState,
} from "@/components/admin/tenant-documents/documentEditState";
import { TenantDocumentEditDialog } from "@/components/admin/tenant-documents/TenantDocumentEditDialog";
import { TenantDocumentUploadRow } from "@/components/admin/tenant-documents/TenantDocumentUploadRow";
import {
  TenantDocumentCards,
  TenantDocumentRecords,
  type DocumentViewProps,
} from "@/components/admin/tenant-documents/TenantDocumentViews";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useDeleteTenantDocument,
  useTenantDocuments,
  type Tenant,
  type TenantDocument,
} from "@/hooks/useTenants";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";
import { documentDownloadName } from "@/lib/documentDownloadName";
import { downloadStoredFile } from "@/lib/downloadStoredFile";
import { downloadTenantDocumentsZip } from "@/lib/downloadZip";

export interface TenantDocumentsManagerProps {
  tenantId: string;
  companyId: string | null;
  /** Full tenant object — required to enable share via tenant's own phone/email. */
  tenant?: Tenant | null;
  /** When true, selection + bulk download/share actions are shown. */
  enableShare?: boolean;
  /**
   * Scopes the manager to one contract: it lists that contract's documents plus
   * the untagged ones, and tags what it uploads to that contract. Omitted, it
   * behaves tenant-wide as before.
   */
  contractId?: string | null;
}

/**
 * مدير وثائق المستأجر: الرفع، عرض البطاقات والسجلات، التعديل، الحذف، والمشاركة.
 *
 * Used by four screens. The upload row, the two views and the edit dialog
 * live in `components/admin/tenant-documents/` (audit M28); the manager keeps
 * the document list, the selection, the share state, the preview and the
 * delete, because all four of those span both views.
 */
export function TenantDocumentsManager({
  tenantId,
  companyId,
  tenant,
  enableShare = false,
  contractId = null,
}: TenantDocumentsManagerProps) {
  const { t } = useI18n();
  const permissions = usePermissions();
  const documents = useTenantDocuments(tenantId, contractId);
  const remove = useDeleteTenantDocument();
  const canEdit = permissions.can(PERMISSIONS.TENANTS_UPDATE);

  const [deleteTarget, setDeleteTarget] = useState<TenantDocument | null>(null);
  const [editState, setEditState] = useState<DocumentEditState | null>(null);
  const [previewDoc, setPreviewDoc] = useState<TenantDocument | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectedDocs = useMemo(
    () => (documents.data ?? []).filter((d) => selected.has(d.id)),
    [documents.data, selected],
  );
  const share = useShareDialogState({ selectedDocs, tenant, t });

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    const docs = documents.data ?? [];
    if (selected.size === docs.length) setSelected(new Set());
    else setSelected(new Set(docs.map((d) => d.id)));
  };
  const clearSelection = () => setSelected(new Set());

  /** ينزّل وثيقة واحدة باسمها المعروض. */
  async function handleDownload(doc: TenantDocument) {
    try {
      await downloadStoredFile(
        "tenant-documents",
        doc.storage_path,
        documentDownloadName(doc.display_name, doc.storage_path),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  /** ينزّل الوثائق المحدّدة في ملف مضغوط واحد. */
  async function handleDownloadZip() {
    if (!selectedDocs.length) return;
    await downloadTenantDocumentsZip(selectedDocs, {
      tenantId,
      tenantLabel: tenant?.code ?? tenant?.name ?? tenantId,
      labels: {
        preparing: t("documents.zipPreparing"),
        ready: t("documents.zipReady"),
        failed: t("documents.zipFailed"),
      },
    });
  }

  /** يحذف الوثيقة المؤكَّدة ويُخرجها من التحديد. */
  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget);
      setDeleteTarget(null);
      toast.success(t("phase2.deleted"));
      // Also drop from selection
      setSelected((prev) => {
        if (!prev.has(deleteTarget.id)) return prev;
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("phase2.deleteError"));
    }
  }

  const docs = documents.data ?? [];
  const totalSize = docs.reduce((acc, d) => acc + (d.size_bytes ?? 0), 0);

  const empty = (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center text-muted-foreground">
      <Upload className="h-8 w-8 opacity-50" />
      <p>{t("documents.noDocuments")}</p>
    </div>
  );

  const viewProps: DocumentViewProps = {
    docs,
    enableShare,
    selected,
    onToggle: toggleSelected,
    canEdit,
    onPreview: setPreviewDoc,
    onDownload: (doc) => void handleDownload(doc),
    onEdit: (doc) => setEditState(editStateFor(doc)),
    onDelete: setDeleteTarget,
    bulkBar:
      enableShare && selected.size > 0 ? (
        <TenantDocumentsBulkBar
          selectedCount={selected.size}
          shareBusy={share.shareBusy}
          t={t}
          onDownloadZip={handleDownloadZip}
          onShareWhatsApp={() => share.openShare("whatsapp")}
          onShareEmail={() => share.openShare("email")}
          onClear={clearSelection}
        />
      ) : null,
  };
  const listState = {
    loading: documents.isLoading,
    error: Boolean(documents.error),
    empty: !documents.data?.length,
  };

  return (
    <div className="space-y-4">
      {!documents.data?.length ? null : (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <Badge variant="secondary">
            {t("documents.totalCount").replace("{{count}}", String(documents.data.length))}
          </Badge>
          <Badge variant="secondary">
            {t("documents.totalSize").replace("{{kb}}", String(Math.ceil(totalSize / 1024)))}
          </Badge>
          {enableShare ? (
            <Badge variant="outline" className="gap-1">
              <Share2 className="size-3" /> {t("documents.shareEnabled")}
            </Badge>
          ) : null}
        </div>
      )}

      <TenantDocumentUploadRow
        tenantId={tenantId}
        companyId={companyId}
        contractId={contractId}
        canEdit={canEdit}
      />

      <Tabs defaultValue="cards">
        <TabsList>
          <TabsTrigger value="cards">
            <LayoutGrid className="size-4" /> {t("documents.cardView")}
          </TabsTrigger>
          <TabsTrigger value="records">
            <TableIcon className="size-4" /> {t("documents.recordsView")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="cards">
          {documents.data?.length ? (
            <TableState {...listState}>
              <TenantDocumentCards {...viewProps} />
            </TableState>
          ) : (
            empty
          )}
        </TabsContent>
        <TabsContent value="records">
          {documents.data?.length ? (
            <TableState {...listState}>
              <TenantDocumentRecords {...viewProps} onToggleAll={toggleSelectAll} />
            </TableState>
          ) : (
            empty
          )}
        </TabsContent>
      </Tabs>

      <TenantDocumentEditDialog state={editState} onStateChange={setEditState} />

      <AttachmentPreviewDialog
        open={Boolean(previewDoc)}
        onOpenChange={(open) => !open && setPreviewDoc(null)}
        bucket="tenant-documents"
        path={previewDoc?.storage_path}
        mimeType={previewDoc?.mime_type}
        title={previewDoc?.display_name ?? previewDoc?.id ?? ""}
        subtitle={previewDoc ? t(`documentType.${previewDoc.type}`) : undefined}
      />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={remove.isPending}
        title={t("phase2.deleteTitle")}
        description={t("documents.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDelete}
      />

      <TenantDocumentShareDialogs state={share} t={t} />
    </div>
  );
}
