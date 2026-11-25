import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auditXlsExport: vi.fn() }));

vi.mock("@/lib/exportAudit", () => ({ auditXlsExport: mocks.auditXlsExport }));

import { downloadXls } from "@/lib/xlsx";

/**
 * Review finding on PR #206: the deposits and expenses screens sit a
 * spreadsheet button next to the CSV one, and only the CSV leg was audited — so
 * the same rows left the application unrecorded through the button beside it.
 * These pin the audit call inside the helper, where a future call site cannot
 * forget it.
 */
describe("downloadXls auditing", () => {
  // The suite runs under the node environment, so the DOM calls the helper
  // makes are stubbed by hand rather than via jsdom.
  beforeEach(() => {
    mocks.auditXlsExport.mockReset();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("document", { createElement: () => ({ click: () => {} }) });
  });

  test("records the export under the name the file is actually saved as", () => {
    downloadXls(
      "deposits",
      ["code", "amount"],
      [
        ["DEP-1", 100],
        ["DEP-2", 250],
      ],
    );

    expect(mocks.auditXlsExport).toHaveBeenCalledWith("deposits.xls", 2);
  });

  test("keeps an already-suffixed name rather than doubling it", () => {
    downloadXls("expenses.xls", ["code"], [["EXP-1"]]);

    expect(mocks.auditXlsExport).toHaveBeenCalledWith("expenses.xls", 1);
  });

  // Nothing left the application, so nothing is recorded — the same rule
  // `downloadCsv` follows for an empty row set.
  test("records nothing when there are no rows to export", () => {
    downloadXls("deposits", ["code"], []);

    expect(mocks.auditXlsExport).not.toHaveBeenCalled();
  });
});
