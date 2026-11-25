import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBulkImport } from "@/hooks/useBulkImport";
import { useI18n } from "@/i18n/provider";
import { parseCsv, type CsvRow } from "@/lib/csv";
import { canonicalizeCsvRows } from "@/lib/csvHeaders";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import {
  validateImportRows,
  type ImportEntity,
  type ImportValidationError,
} from "@/lib/bulkImportSchemas";

export function CsvImportDialog({
  entity,
  open,
  onOpenChange,
}: {
  entity: ImportEntity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const bulkImport = useBulkImport();
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [serverErrors, setServerErrors] = useState<ImportValidationError[]>([]);
  const validation = useMemo(() => validateImportRows(entity, rows), [entity, rows]);
  const headers = useMemo(() => Object.keys(rows[0] ?? {}), [rows]);
  const invalidRows = new Set(validation.errors.map((error) => error.row));

  useEffect(() => {
    if (!open) {
      setRows([]);
      setFileName("");
      setParseError("");
      setServerErrors([]);
    }
  }, [open]);

  const selectFile = async (file?: File) => {
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setServerErrors([]);
    try {
      // Arabic templates carry translated headers — map them back to the
      // canonical English keys the validators and server import expect.
      const parsed = canonicalizeCsvRows(parseCsv(await file.text()));
      if (!parsed.length) throw new Error(t("import.emptyFile"));
      setRows(parsed);
    } catch (error) {
      setRows([]);
      setParseError(error instanceof Error ? error.message : t("import.parseError"));
    }
  };

  const confirm = async () => {
    try {
      const result = await bulkImport.mutateAsync({
        entity,
        rows: validation.validRows,
      });
      setServerErrors(result.errors);
      toast.success(
        `${result.inserted} ${t("import.rowsImported")} / ${validation.errors.length + result.errors.length} ${t("import.errors")}`,
      );
      if (!result.errors.length) onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  const errors = [...validation.errors, ...serverErrors];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-dashed p-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => downloadImportTemplate(entity, locale)}
          >
            <Download className="size-4" />
            {t("import.downloadTemplate")}
          </Button>
          <Input
            className="mt-3"
            type="file"
            accept=".csv,text/csv"
            aria-label={t("import.chooseFile")}
            onChange={(event) => void selectFile(event.target.files?.[0])}
          />
          {fileName && <p className="mt-2 text-sm text-muted-foreground">{fileName}</p>}
          {parseError && <p className="mt-2 text-sm text-destructive">{parseError}</p>}
        </div>

        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                <CheckCircle2 className="me-1 size-3" />
                {validation.validRows.length} {t("import.validRows")}
              </Badge>
              <Badge variant={errors.length ? "destructive" : "secondary"}>
                <AlertCircle className="me-1 size-3" />
                {errors.length} {t("import.invalidRows")}
              </Badge>
            </div>

            <div className="max-h-96 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{t("import.validation")}</TableHead>
                    {headers.map((header) => (
                      <TableHead key={header}>{header}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, index) => {
                    const rowNumber = index + 2;
                    const error = errors.find((item) => item.row === rowNumber);
                    return (
                      <TableRow
                        key={rowNumber}
                        className={invalidRows.has(rowNumber) ? "bg-destructive/10" : ""}
                      >
                        <TableCell>{rowNumber}</TableCell>
                        <TableCell
                          className={error ? "min-w-64 text-destructive" : "text-emerald-700"}
                        >
                          {error
                            ? `${error.fields.join(", ")}: ${t("import.invalidValue")}`
                            : t("import.valid")}
                        </TableCell>
                        {headers.map((header) => (
                          <TableCell key={header} className="max-w-56 truncate">
                            {row[header]}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!validation.validRows.length || bulkImport.isPending} onClick={confirm}>
            <Upload className="size-4" />
            {bulkImport.isPending ? t("common.loading") : t("import.confirmValid")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
