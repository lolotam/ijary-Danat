import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { globSync } from "tinyglobby";

/**
 * Tenant detail → Monthly invoices, 2026-08-08 — marking an invoice paid failed
 * with a validation error while the identical icon on /admin/invoices worked:
 *
 *   [{ "code": "custom",
 *      "message": "A payment method is required when marking an invoice paid.",
 *      "path": ["paymentMethod"] }]
 *
 * `setInvoicePaidSchema` refines that a method must be present whenever
 * `paid: true`. `admin.invoices.tsx` satisfies it by opening
 * `MarkInvoicePaidDialog` first; `InvoiceRowsTable` was written before the
 * method became mandatory and still called the server function directly with
 * `{ invoiceId, paid }`. Nothing failed at build time — the field is optional in
 * the object type and only the cross-field refine rejects it, at runtime.
 *
 * The rule is therefore about *call sites*, not about one component, and a third
 * table showing invoices would reintroduce it. Read from source rather than
 * rendered: `DialogContent` renders through a Radix portal that
 * `renderToStaticMarkup` does not produce, and this repo's component tests run
 * in a node environment with no DOM to click in. Same reasoning, and same
 * technique, as the fixed-height dialog invariant in `ui/dialog.test.tsx`.
 */
const TOGGLE_CALL = /(?:togglePaid|setInvoicePaid)\(\s*\{\s*data:\s*\{([^}]*)\}/gs;

function sourceFilesImporting(specifier: string): Array<{ file: string; source: string }> {
  return globSync(["src/**/*.tsx", "src/**/*.ts"], { cwd: process.cwd() })
    .filter((file) => !file.includes(".test."))
    .map((file) => ({ file, source: readFileSync(join(process.cwd(), file), "utf8") }))
    .filter(({ source }) => source.includes(specifier));
}

describe("marking an invoice paid always collects a payment method first", () => {
  test("every caller of set_invoice_paid routes through the method dialog", () => {
    // The server function is imported by exactly the screens that can toggle an
    // invoice; each of them must be able to ask why before it does.
    const callers = sourceFilesImporting("@/fns/setInvoicePaid");

    expect(callers.length).toBeGreaterThan(0);
    const missingDialog = callers
      .filter(({ source }) => !source.includes("MarkInvoicePaidDialog"))
      .map(({ file }) => file);

    expect(missingDialog).toEqual([]);
  });

  test("no call site sends the toggle without a paymentMethod field", () => {
    // The direct assertion of the reported bug: a payload of
    // `{ invoiceId, paid }` is exactly what the schema rejects.
    const offenders: string[] = [];

    for (const { file, source } of sourceFilesImporting("@/fns/setInvoicePaid")) {
      for (const match of source.matchAll(TOGGLE_CALL)) {
        if (!match[1].includes("paymentMethod")) {
          offenders.push(`${file}: { ${match[1].trim()} }`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the dialog refuses to submit until a method is chosen", () => {
    // The other half of the contract: the schema rejects an empty method, so a
    // dialog that let the button through would trade a silent failure for a
    // loud one rather than fixing it.
    const source = readFileSync(
      join(process.cwd(), "src/components/admin/MarkInvoicePaidDialog.tsx"),
      "utf8",
    );

    expect(source).toMatch(/disabled=\{!method \|\| pending\}/);
  });

  test("a bulk selection uses the count description instead of a single code", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/admin/MarkInvoicePaidDialog.tsx"),
      "utf8",
    );

    expect(source).toMatch(/selectedCount\?: number/);
    expect(source).toMatch(/invoices\.markPaidBulkDescription/);
    expect(source).toMatch(/\{count\}/);
  });
});
