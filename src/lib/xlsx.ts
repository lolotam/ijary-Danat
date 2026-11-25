import { auditXlsExport } from "@/lib/exportAudit";
import { escapeHtml } from "@/lib/html";

/** يحوّل خلية بأي نوع إلى نص مهرَّب — القيم الفارغة تصبح خلية فارغة. */
function escapeCell(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

/**
 * ينزّل صفوفاً كملف XLS ويسجّل التصدير في سجل التدقيق.
 *
 * The audit call lives here rather than at the call sites for the same reason
 * it lives inside `downloadCsv`: scattered guards are where one gets missed,
 * and a missed export is an invisible one.
 */
export function downloadXls(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>,
): void {
  if (!rows.length) return;
  const table = `<!doctype html><html><head><meta charset="utf-8"></head><body><table><thead><tr>${headers
    .map((header) => `<th>${escapeCell(header)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeCell(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></body></html>`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob(["\uFEFF", table], { type: "application/vnd.ms-excel;charset=utf-8" }),
  );
  link.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
  auditXlsExport(link.download, rows.length);
}
