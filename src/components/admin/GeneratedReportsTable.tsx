import type { Dispatch, SetStateAction } from "react";
import { Download, Eye, Printer, RefreshCw, Trash2 } from "lucide-react";

import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { GeneratedReportWithSchedule } from "@/hooks/useGeneratedReports";
import { useI18n } from "@/i18n/provider";
import { generatedReportSortValue } from "@/lib/adminTableSortValues";
import { reportLocaleTone } from "@/lib/statusTone";

/**
 * جدول التقارير المُنشأة — الترتيب على تاريخ الإنشاء والفترة كقيم ISO.
 */
export function GeneratedReportsTable({
  items,
  page,
  canDelete,
  selected,
  setSelected,
  resendPending,
  deletePending,
  onPreview,
  onPrint,
  onDownload,
  onResend,
  onDelete,
}: {
  items: GeneratedReportWithSchedule[];
  page: number;
  canDelete: boolean;
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  resendPending: boolean;
  deletePending: boolean;
  onPreview: (report: GeneratedReportWithSchedule) => void;
  onPrint: (report: GeneratedReportWithSchedule) => void;
  onDownload: (report: GeneratedReportWithSchedule) => void;
  onResend: (id: string) => void;
  onDelete: (report: GeneratedReportWithSchedule) => void;
}) {
  const { locale, t } = useI18n();
  const {
    sort,
    toggle,
    sorted: sortedGenerated,
  } = useTableSort(items, (report, key) => generatedReportSortValue(report, key, locale));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {canDelete && (
            <TableHead className="w-8">
              <Checkbox
                checked={sortedGenerated.length > 0 && selected.length === sortedGenerated.length}
                onCheckedChange={(checked) =>
                  setSelected(checked ? sortedGenerated.map((row) => row.id) : [])
                }
              />
            </TableHead>
          )}
          <TableHead>#</TableHead>
          <SortableHead sortKey="code" sort={sort} toggle={toggle}>
            {t("reports.code")}
          </SortableHead>
          <SortableHead sortKey="name" sort={sort} toggle={toggle}>
            {t("common.name")}
          </SortableHead>
          <SortableHead sortKey="period" sort={sort} toggle={toggle}>
            {t("reports.period")}
          </SortableHead>
          <SortableHead sortKey="locale" sort={sort} toggle={toggle}>
            {t("reports.locale")}
          </SortableHead>
          <SortableHead sortKey="delivery" sort={sort} toggle={toggle}>
            {t("reports.delivery")}
          </SortableHead>
          <SortableHead sortKey="created_at" sort={sort} toggle={toggle}>
            {t("reports.lastRun")}
          </SortableHead>
          <TableHead>{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedGenerated.map((report, index) => (
          <TableRow key={report.id}>
            {canDelete && (
              <TableCell>
                <Checkbox
                  checked={selected.includes(report.id)}
                  onCheckedChange={(checked) =>
                    setSelected((prev) =>
                      checked ? [...prev, report.id] : prev.filter((id) => id !== report.id),
                    )
                  }
                />
              </TableCell>
            )}
            <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
            <TableCell className="font-mono">{report.schedule?.code ?? "—"}</TableCell>
            <TableCell>
              <div className="font-semibold text-foreground">
                {report.schedule
                  ? locale === "ar"
                    ? report.schedule.name_ar
                    : report.schedule.name_en || report.schedule.name_ar
                  : "—"}
              </div>
              {report.schedule && (
                <div className="text-xs text-muted-foreground">
                  {locale === "ar" ? report.schedule.name_en : report.schedule.name_ar}
                </div>
              )}
            </TableCell>
            <TableCell>
              {report.period_start ?? "—"} — {report.period_end ?? "—"}
            </TableCell>
            <TableCell>
              {report.locale ? (
                <Badge variant={reportLocaleTone(report.locale)}>
                  {t(`localeName.${report.locale}`)}
                </Badge>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell>
              <Badge variant={report.sent ? "default" : "destructive"}>
                {report.sent ? t("notificationState.sent") : t("notificationState.failed")}
              </Badge>
            </TableCell>
            <TableCell className="text-xs">
              {new Date(report.created_at).toLocaleString("en-GB")}
            </TableCell>
            <TableCell>
              <div className="flex items-center">
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("common.preview")}
                  aria-label={t("common.preview")}
                  disabled={!report.html_content}
                  onClick={() => onPreview(report)}
                >
                  <Eye className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("reports.print")}
                  aria-label={t("reports.print")}
                  disabled={!report.html_content}
                  onClick={() => onPrint(report)}
                >
                  <Printer className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("common.downloadPdf")}
                  aria-label={t("common.downloadPdf")}
                  disabled={!report.html_content}
                  onClick={() => onDownload(report)}
                >
                  <Download className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("reports.resend")}
                  aria-label={t("reports.resend")}
                  disabled={!report.schedule_id || resendPending}
                  onClick={() => onResend(report.id)}
                >
                  <RefreshCw className="size-4" />
                </Button>
                {canDelete && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    disabled={deletePending}
                    onClick={() => onDelete(report)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
