import { useState } from "react";
import { toast } from "sonner";

import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { GeneratedReportPreviewDialog } from "@/components/admin/GeneratedReportPreviewDialog";
import { GeneratedReportsTable } from "@/components/admin/GeneratedReportsTable";
import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  useDeleteGeneratedReport,
  useGeneratedReports,
  useResendGeneratedReport,
  type GeneratedReportWithSchedule,
} from "@/hooks/useGeneratedReports";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";
import { downloadHtmlAsPdf, openPrintableDocument } from "@/lib/printDocument";
import { safeFilename } from "@/lib/safeFilename";

/**
 * CSS الطباعة لتقرير مولَّد: صفحة A4 بلا الظل والخلفية المخصّصين للشاشة.
 */
const REPORT_PRINT_CSS = `
    @page { size: A4; margin: 10mm; }
    body { background: #f8f9ff !important; }
    .print-sheet {
      max-width: 100% !important;
      min-height: auto !important;
      box-shadow: none !important;
      background: transparent !important;
    }
    @media print {
      body { background: #ffffff !important; padding: 0 !important; }
    }
  `;

/**
 * لوحة التقارير المولَّدة: المعاينة والطباعة وتنزيل PDF وإعادة الإرسال والحذف.
 */
export function GeneratedReportsPanel() {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const canDelete = permissions.can(PERMISSIONS.REPORTS_DELETE);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<GeneratedReportWithSchedule | null>(null);
  const [previewReport, setPreviewReport] = useState<GeneratedReportWithSchedule | null>(null);

  const generated = useGeneratedReports({ page, pageSize: 10, search: debouncedSearch }, true);
  const resendGenerated = useResendGeneratedReport();
  const deleteGenerated = useDeleteGeneratedReport();

  const reportTitle = (report: GeneratedReportWithSchedule) => {
    const scheduleName = report.schedule
      ? locale === "ar"
        ? report.schedule.name_ar
        : report.schedule.name_en || report.schedule.name_ar
      : t("reports.generated");
    if (report.period_start || report.period_end) {
      return `${scheduleName} (${report.period_start ?? "—"} — ${report.period_end ?? "—"})`;
    }
    return scheduleName;
  };

  const preview = async (report: GeneratedReportWithSchedule) => {
    if (!report.html_content?.trim()) {
      toast.error(t("reports.noHtml"));
      return;
    }
    setPreviewReport(report);
  };

  const downloadPdf = async (report: GeneratedReportWithSchedule) => {
    if (!report.html_content?.trim()) {
      toast.error(t("reports.noHtml"));
      return;
    }
    const title = reportTitle(report);
    const filename = `${safeFilename(report.schedule?.code || title)}_${safeFilename(
      report.period_start || report.id.slice(0, 8),
    )}.pdf`;
    try {
      const ok = await downloadHtmlAsPdf(report.html_content, filename, {
        dir: report.locale === "en" ? "ltr" : "rtl",
        title,
        extraCss: REPORT_PRINT_CSS,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch (error) {
      // The toast says "PDF failed"; the console keeps the reason (audit M16).
      console.error("[reports] generated-report PDF download failed", error);
      toast.error(t("common.pdfFailed"));
    }
  };

  const printFullPage = async (report: GeneratedReportWithSchedule) => {
    if (!report.html_content?.trim()) {
      toast.error(t("reports.noHtml"));
      return;
    }
    const win = await openPrintableDocument(report.html_content, {
      title: reportTitle(report),
      dir: report.locale === "en" ? "ltr" : "rtl",
      extraCss: REPORT_PRINT_CSS,
      autoPrint: true,
    });
    if (!win) toast.error(t("common.popupBlocked"));
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">{t("reports.generated")}</CardTitle>
          <Input
            className="max-w-sm"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={t("common.search")}
          />
        </CardHeader>
        <CardContent className="p-0">
          {canDelete && (
            <div className="px-4 pb-2">
              <BulkDeleteBar
                selected={selected}
                clear={() => setSelected([])}
                deleteOne={(id) => deleteGenerated.mutateAsync(id).then(() => undefined)}
                entityLabel={t("reports.generated")}
              />
            </div>
          )}
          <TableState
            loading={generated.isLoading}
            error={generated.isError}
            empty={!generated.data?.items.length}
          >
            <GeneratedReportsTable
              items={generated.data?.items ?? []}
              page={page}
              canDelete={canDelete}
              selected={selected}
              setSelected={setSelected}
              resendPending={resendGenerated.isPending}
              deletePending={deleteGenerated.isPending}
              onPreview={preview}
              onPrint={(report) => void printFullPage(report)}
              onDownload={(report) => void downloadPdf(report)}
              onResend={(id) =>
                resendGenerated.mutate(id, {
                  onError: (error) => toast.error(error.message),
                  // The report is queued, not sent: the worker sends it again.
                  onSuccess: () => toast.success(t("reports.resendQueued")),
                })
              }
              onDelete={setPendingDelete}
            />
          </TableState>
          <Pager page={page} pageSize={10} count={generated.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <DeleteConfirmation
        open={Boolean(pendingDelete)}
        pending={deleteGenerated.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.deleteDescription")}
        close={() => setPendingDelete(null)}
        confirm={async () => {
          if (!pendingDelete) return;
          const id = pendingDelete.id;
          try {
            await deleteGenerated.mutateAsync(id);
            setSelected((prev) => prev.filter((x) => x !== id));
            setPendingDelete(null);
            toast.success(t("phase2.deleted"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />

      <GeneratedReportPreviewDialog
        open={Boolean(previewReport)}
        report={previewReport}
        onOpenChange={(open) => !open && setPreviewReport(null)}
      />
    </>
  );
}
