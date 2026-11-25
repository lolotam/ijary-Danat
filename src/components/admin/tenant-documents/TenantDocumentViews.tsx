import type { ReactNode } from "react";
import { Download, Eye, Pencil, Trash2 } from "lucide-react";

import { FileTypeIcon } from "@/components/admin/FileTypeIcon";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TenantDocument } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";

/** ما يشترك فيه عرضا البطاقات والسجلات: الوثائق، التحديد، والإجراءات. */
export interface DocumentViewProps {
  docs: TenantDocument[];
  enableShare: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  canEdit: boolean;
  onPreview: (doc: TenantDocument) => void;
  onDownload: (doc: TenantDocument) => void;
  onEdit: (doc: TenantDocument) => void;
  onDelete: (doc: TenantDocument) => void;
  /** شريط الإجراءات الجماعية، أو null حين لا تحديد. */
  bulkBar: ReactNode;
}

/** يعرض حجم الملف بالكيلوبايت مقرّباً للأعلى، أو شرطة إن لم يُعرف. */
function sizeLabel(doc: TenantDocument): string {
  return doc.size_bytes ? `${Math.ceil(doc.size_bytes / 1024)} KB` : "—";
}

/** عرض البطاقات لوثائق المستأجر. */
export function TenantDocumentCards({
  docs,
  enableShare,
  selected,
  onToggle,
  canEdit,
  onPreview,
  onDownload,
  onEdit,
  onDelete,
  bulkBar,
}: DocumentViewProps) {
  const { t } = useI18n();
  return (
    <>
      {bulkBar}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {docs.map((doc) => (
          <Card key={doc.id} className="overflow-hidden">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  {enableShare ? (
                    <Checkbox
                      checked={selected.has(doc.id)}
                      onCheckedChange={() => onToggle(doc.id)}
                      aria-label={t("common.select")}
                    />
                  ) : null}
                  <div className="flex size-10 items-center justify-center rounded bg-muted">
                    <FileTypeIcon
                      mimeType={doc.mime_type}
                      path={doc.storage_path}
                      className="h-5 w-5 text-muted-foreground"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{doc.display_name ?? doc.id}</p>
                    <p className="text-xs text-muted-foreground">{sizeLabel(doc)}</p>
                  </div>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {t(`documentType.${doc.type}`)}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => onPreview(doc)}>
                  <Eye className="size-4" /> {t("common.preview")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDownload(doc)}>
                  <Download className="size-4" /> {t("documents.download")}
                </Button>
                {canEdit ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onEdit(doc)}>
                      <Pencil className="size-4" /> {t("documents.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(doc)}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  </>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

/** عرض السجلات (جدول) لوثائق المستأجر، مع تحديد الكل. */
export function TenantDocumentRecords({
  docs,
  enableShare,
  selected,
  onToggle,
  onToggleAll,
  canEdit,
  onPreview,
  onDownload,
  onEdit,
  onDelete,
  bulkBar,
}: DocumentViewProps & { onToggleAll: () => void }) {
  const { t } = useI18n();
  return (
    <>
      {bulkBar}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {enableShare ? (
                <TableHead className="w-10">
                  <Checkbox
                    checked={!!docs.length && selected.size === docs.length}
                    onCheckedChange={onToggleAll}
                    aria-label={t("common.select")}
                  />
                </TableHead>
              ) : null}
              <TableHead className="w-10">#</TableHead>
              <TableHead>{t("documents.name")}</TableHead>
              <TableHead>{t("documents.type")}</TableHead>
              <TableHead>{t("documents.size")}</TableHead>
              <TableHead>{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((doc, index) => (
              <TableRow key={doc.id}>
                {enableShare ? (
                  <TableCell>
                    <Checkbox
                      checked={selected.has(doc.id)}
                      onCheckedChange={() => onToggle(doc.id)}
                      aria-label={t("common.select")}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <FileTypeIcon
                      mimeType={doc.mime_type}
                      path={doc.storage_path}
                      className="h-4 w-4 text-muted-foreground"
                    />
                    <span className="truncate">{doc.display_name ?? doc.id}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{t(`documentType.${doc.type}`)}</Badge>
                </TableCell>
                <TableCell>{sizeLabel(doc)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("common.preview")}
                      aria-label={t("common.preview")}
                      onClick={() => onPreview(doc)}
                    >
                      <Eye className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("documents.download")}
                      aria-label={t("documents.download")}
                      onClick={() => onDownload(doc)}
                    >
                      <Download className="size-4" />
                    </Button>
                    {canEdit ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("documents.edit")}
                          aria-label={t("documents.edit")}
                          onClick={() => onEdit(doc)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <TableActionButton
                          action="delete"
                          disabled={!canEdit}
                          onClick={() => onDelete(doc)}
                        />
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
