import { auditCsvExport } from "@/lib/exportAudit";
import { localizeCsvHeader, localizeCsvRows, type CsvLocale } from "@/lib/csvHeaders";

export type CsvRow = Record<string, string>;

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function parseCsv(text: string): CsvRow[] {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  row.push(cell);
  if (row.some((value) => value.length > 0)) matrix.push(row);
  if (matrix.length < 2) return [];

  const headers = matrix[0].map((header, index) => header.trim() || `column_${index + 1}`);
  return matrix
    .slice(1)
    .map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
    );
}

export function serializeCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return serializeCsvWithHeaders(headers, rows);
}

export function serializeCsvWithHeaders(
  headers: readonly string[],
  rows: Array<Record<string, unknown>>,
): string {
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

function downloadCsvContent(filename: string, content: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }),
  );
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * ينزّل صفوفاً كملف CSV ويسجّل التصدير في سجل التدقيق.
 *
 * The audit call lives here rather than at the fifteen call sites for the same
 * reason `runEventWorkflow` owns the pause check: scattered guards are where
 * one gets missed, and a missed export is an invisible one. `downloadCsvTemplate`
 * deliberately does not record — an empty header row carries no data.
 */
export function downloadCsv(
  filename: string,
  rows: Array<Record<string, unknown>>,
  locale: CsvLocale = "en",
): void {
  if (!rows.length) return;
  downloadCsvContent(filename, serializeCsv(localizeCsvRows(rows, locale)));
  auditCsvExport(filename, rows.length);
}

export function downloadCsvTemplate(
  filename: string,
  headers: readonly string[],
  locale: CsvLocale = "en",
): void {
  downloadCsvContent(
    filename,
    serializeCsvWithHeaders(
      headers.map((header) => localizeCsvHeader(header, locale)),
      [],
    ),
  );
}

export function exportRecordsToCsv(
  rows: Array<Record<string, unknown>>,
  filename: string,
  locale: CsvLocale = "en",
): void {
  downloadCsv(filename, rows, locale);
}
