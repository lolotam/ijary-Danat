import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logAudit: vi.fn() }));

vi.mock("@/lib/audit", () => ({ logAuditForCurrentSession: mocks.logAudit }));

import {
  auditCsvExport,
  auditPrint,
  auditXlsExport,
  EXPORT_CSV_ACTION,
  EXPORT_XLS_ACTION,
  PRINT_ACTION,
} from "./exportAudit";

describe("export auditing", () => {
  beforeEach(() => {
    mocks.logAudit.mockReset().mockResolvedValue({ id: "audit-id" });
  });

  /**
   * An export removes data from every control the application has — RLS,
   * permissions, the portal boundary — and left no trace at all, so "who
   * downloaded the tenant list?" had no answer.
   */
  it("records a CSV export with its filename and row count", () => {
    auditCsvExport("tenants.csv", 57);

    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: EXPORT_CSV_ACTION,
      entityType: "export",
      after: { filename: "tenants.csv", rows: 57 },
    });
  });

  /**
   * A spreadsheet download removes exactly the same rows as the CSV button
   * beside it, so it gets its own action code rather than being folded into
   * `export.csv` — the trail should say which button was pressed.
   */
  it("records an XLS export under its own action", () => {
    auditXlsExport("deposits.xls", 12);

    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: EXPORT_XLS_ACTION,
      entityType: "export",
      after: { filename: "deposits.xls", rows: 12 },
    });
  });

  it("records a print against the record that was printed", () => {
    auditPrint("tenant", "11111111-1111-4111-8111-111111111111");

    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: PRINT_ACTION,
      entityType: "tenant",
      entityId: "11111111-1111-4111-8111-111111111111",
      after: { surface: "browser-print" },
    });
  });

  /**
   * The file reaches the browser before this resolves, so a rejected audit must
   * not surface as an unhandled rejection — and must certainly not deny an
   * allowed export because the record of it could not be written.
   */
  it("does not reject when the audit write fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.logAudit.mockRejectedValue(new Error("no session"));

    expect(() => auditCsvExport("tenants.csv", 57)).not.toThrow();
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

    consoleError.mockRestore();
  });
});
