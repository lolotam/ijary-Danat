import { logAuditForCurrentSession } from "@/lib/audit";

/**
 * تسجيل ما يغادر التطبيق: تصدير CSV وطباعة الصفحات.
 *
 * An export is the one action that removes data from every control the
 * application has — RLS, permissions, the portal boundary — and it left no
 * trace at all. "Who downloaded the tenant list?" had no answer.
 *
 * Browser-only by construction: this reaches the audit log through
 * `logAuditForCurrentSession`, which needs the signed-in session. Nothing under
 * `src/fns` imports it, and nothing should.
 */

/** الإجراء المسجَّل لكل تنزيل CSV. */
export const EXPORT_CSV_ACTION = "export.csv";
/** الإجراء المسجَّل لكل تنزيل XLS. */
export const EXPORT_XLS_ACTION = "export.xls";
/** الإجراء المسجَّل لكل طباعة صفحة. */
export const PRINT_ACTION = "export.print";

/**
 * يكتب صف تدقيق دون أن يمنع التصدير نفسه.
 *
 * Fire-and-forget on purpose. The file is already being handed to the browser
 * by the time this resolves, so making the download wait on an audit round-trip
 * would only add latency — and failing it would deny an allowed action because
 * the record of it could not be written.
 */
function recordQuietly(input: Parameters<typeof logAuditForCurrentSession>[0]): void {
  void logAuditForCurrentSession(input).catch((error) => {
    console.error("Export audit write failed", error);
  });
}

/**
 * يسجّل تصدير ملف CSV باسمه وعدد صفوفه.
 *
 * The row count is the useful part: "someone exported tenants.csv" and
 * "someone exported all 57 tenants" answer different questions.
 */
export function auditCsvExport(filename: string, rowCount: number): void {
  recordQuietly({
    action: EXPORT_CSV_ACTION,
    entityType: "export",
    after: { filename, rows: rowCount },
  });
}

/**
 * يسجّل تصدير ملف XLS باسمه وعدد صفوفه.
 *
 * Review finding on PR #206: the deposits and expenses screens sit a
 * spreadsheet button next to the CSV one, and only the CSV leg was audited — so
 * the same rows left the application unrecorded through the button beside it.
 */
export function auditXlsExport(filename: string, rowCount: number): void {
  recordQuietly({
    action: EXPORT_XLS_ACTION,
    entityType: "export",
    after: { filename, rows: rowCount },
  });
}

/**
 * يسجّل طباعة صفحة سجل بعينه.
 *
 * A printed page leaves the application exactly as an export does; the only
 * difference is that the browser, not our code, writes the file.
 */
export function auditPrint(entityType: string, entityId: string | null): void {
  recordQuietly({
    action: PRINT_ACTION,
    entityType,
    entityId,
    after: { surface: "browser-print" },
  });
}
