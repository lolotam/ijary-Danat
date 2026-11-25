import { describe, expect, it } from "vitest";

import { receiptDocumentFilename } from "@/lib/receiptDocumentFilename";

/**
 * الاسم الذي يصل المستأجر هو رمز الإيصال، لا رمز الفاتورة.
 *
 * The reported defect: a paid invoice downloaded as `INV-0056676.pdf`, a number
 * that appears nowhere on the receipt the tenant was issued for the same money.
 */
describe("receiptDocumentFilename", () => {
  it("names the file after the receipt when there is one", () => {
    expect(
      receiptDocumentFilename("REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V", "INV-0056676"),
    ).toBe("REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V.pdf");
  });

  it("falls back to the document's own code when no receipt is on record", () => {
    // Two real cases reach this: the receipt trigger has not fired yet, and
    // portal RLS hides a receipt that is not visible_to_tenant.
    expect(receiptDocumentFilename(null, "INV-0056676")).toBe("INV-0056676.pdf");
    expect(receiptDocumentFilename(undefined, "PAY-0001039")).toBe("PAY-0001039.pdf");
  });

  it("treats a blank receipt code as no receipt at all", () => {
    // An empty string is not a name; without this it produces ".pdf".
    expect(receiptDocumentFilename("   ", "INV-0056676")).toBe("INV-0056676.pdf");
  });

  it("keeps the name safe to write to a filesystem", () => {
    expect(receiptDocumentFilename("../../etc/passwd", "INV-1")).not.toContain("/");
  });
});
