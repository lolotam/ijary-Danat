import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auditCsvExport: vi.fn() }));

vi.mock("@/lib/exportAudit", () => ({ auditCsvExport: mocks.auditCsvExport }));

import { downloadCsv, downloadCsvTemplate, serializeCsvWithHeaders } from "@/lib/csv";

describe("serializeCsvWithHeaders", () => {
  test("returns a header row when no data rows exist", () => {
    expect(serializeCsvWithHeaders(["property_code", "title"], [])).toBe("property_code,title");
  });
});

/**
 * The audit call lives inside `downloadCsv` rather than at its fifteen call
 * sites, so a future export cannot be added without being recorded. These pin
 * that placement — and that a template, which carries no data, is not recorded.
 */
describe("downloadCsv auditing", () => {
  // The suite runs under the node environment, so the three DOM calls
  // downloadCsvContent makes are stubbed by hand rather than via jsdom.
  beforeEach(() => {
    mocks.auditCsvExport.mockReset();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("document", { createElement: () => ({ click: () => {} }) });
  });

  test("records the export with its filename and row count", () => {
    downloadCsv("tenants.csv", [{ name: "A" }, { name: "B" }]);

    expect(mocks.auditCsvExport).toHaveBeenCalledWith("tenants.csv", 2);
  });

  test("records nothing when there are no rows to export", () => {
    downloadCsv("tenants.csv", []);

    expect(mocks.auditCsvExport).not.toHaveBeenCalled();
  });

  test("does not record a blank import template as a data export", () => {
    downloadCsvTemplate("tenants-template.csv", ["name", "mobile"]);

    expect(mocks.auditCsvExport).not.toHaveBeenCalled();
  });
});
