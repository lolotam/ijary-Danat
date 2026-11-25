import { Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GeneratedReportWithSchedule } from "@/hooks/useGeneratedReports";
import { useI18n } from "@/i18n/provider";
import { downloadHtmlAsPdf, openPrintableDocument, printHtmlDocument } from "@/lib/printDocument";
import { safeFilename } from "@/lib/safeFilename";

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

export function GeneratedReportPreviewDialog({
  open,
  report,
  onOpenChange,
}: {
  open: boolean;
  report: GeneratedReportWithSchedule | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { locale, t } = useI18n();

  if (!report) return null;

  const scheduleName = report.schedule
    ? locale === "ar"
      ? report.schedule.name_ar
      : report.schedule.name_en || report.schedule.name_ar
    : t("reports.generated");
  const period =
    report.period_start || report.period_end
      ? `${report.period_start ?? "—"} — ${report.period_end ?? "—"}`
      : "";
  const title = period ? `${scheduleName} (${period})` : scheduleName;
  const html = report.html_content?.trim() ?? "";
  const dir = report.locale === "en" ? "ltr" : "rtl";
  const filename = `${safeFilename(report.schedule?.code || scheduleName)}_${safeFilename(
    report.period_start || report.id.slice(0, 8),
  )}.pdf`;

  const ensureHtml = (): string | null => {
    if (!html) {
      toast.error(t("reports.noHtml"));
      return null;
    }
    return html;
  };

  const runPreview = async () => {
    const body = ensureHtml();
    if (!body) return;
    const win = await openPrintableDocument(body, {
      title,
      dir,
      extraCss: REPORT_PRINT_CSS,
      autoPrint: false,
    });
    if (!win) toast.error(t("common.popupBlocked"));
  };

  const runPrint = async () => {
    const body = ensureHtml();
    if (!body) return;
    const ok = await printHtmlDocument(body, {
      title,
      dir,
      extraCss: REPORT_PRINT_CSS,
    });
    if (!ok) toast.error(t("common.popupBlocked"));
  };

  const runPdf = async () => {
    const body = ensureHtml();
    if (!body) return;
    try {
      const ok = await downloadHtmlAsPdf(body, filename, {
        dir,
        title,
        extraCss: REPORT_PRINT_CSS,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch (error) {
      console.error("[report-pdf] failed:", error);
      toast.error(t("common.pdfFailed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {report.schedule?.code ? (
              <span className="font-mono">{report.schedule.code}</span>
            ) : (
              t("reports.previewGenerated")
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-slate-50">
          {html ? (
            <iframe
              title={title}
              className="h-[min(70vh,720px)] w-full border-0 bg-white"
              sandbox=""
              srcDoc={html}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{t("reports.noHtml")}</p>
          )}
        </div>

        <DialogFooter className="flex-row flex-wrap justify-end gap-2 sm:gap-2">
          <Button type="button" variant="outline" disabled={!html} onClick={runPreview}>
            <Printer className="size-4" />
            {t("common.preview")}
          </Button>
          <Button type="button" variant="outline" disabled={!html} onClick={runPrint}>
            <Printer className="size-4" />
            {t("reports.print")}
          </Button>
          <Button type="button" disabled={!html} onClick={runPdf}>
            <Download className="size-4" />
            {t("common.downloadPdf")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
