import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ dir: "ltr", locale: "en", t: (key: string) => key }),
}));

import { RecordPanelRowActions } from "@/components/admin/RecordPanelRowActions";
import { PartialPaymentInvoiceField } from "@/components/admin/RecordPanelDialog";
import { isSettleableForPartialLink } from "@/lib/invoiceBulkSelection";
import type { InvoiceState } from "@/integrations/supabase/database.types";

/**
 * يقرأ خاصية disabled من زر له aria-label معيّن.
 *
 * shadcn `Button` bakes `disabled:*` classes into every render, so matching
 * /disabled/ on the markup is vacuously true. The attribute is the real gate.
 */
function buttonDisabled(markup: string, ariaLabel: string): boolean {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`, "i"));
  return Boolean(match && /\sdisabled(?:=|(?=\s|>))/.test(match[0]));
}

/**
 * NOT COVERED HERE: that the confirmation dialog actually gates the delete.
 *
 * The project has no DOM testing library, so a click cannot be simulated, and
 * `AlertDialogContent` renders through a Radix portal that produces nothing
 * under `renderToStaticMarkup` — the same limitation documented for
 * `SelectContent` below. Any assertion on the dialog's text would pass whether
 * the dialog were wired up or deleted, which is worse than no test. The gating
 * is verified by hand against the running app.
 */
describe("RecordPanelRowActions", () => {
  // Delete stays enabled on a locked row on purpose. Since migration 160 a
  // partial payment that settles an invoice in full makes that invoice `paid`,
  // which makes the row `complete`, which is what `locked` tests — so disabling
  // delete here would strand a settled partial payment with no way to reverse
  // it, the row being immutable and its payment refusing reversal.
  it("locks Edit but not Delete on a linked-complete row", () => {
    const markup = renderToStaticMarkup(
      <RecordPanelRowActions
        locked
        canUpdate
        canDelete
        isMobile={false}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(buttonDisabled(markup, "common.edit")).toBe(true);
    expect(buttonDisabled(markup, "common.delete")).toBe(false);
  });

  it("leaves Edit and Delete enabled on an unlinked complete row", () => {
    const markup = renderToStaticMarkup(
      <RecordPanelRowActions
        locked={false}
        canUpdate
        canDelete
        isMobile={false}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(buttonDisabled(markup, "common.edit")).toBe(false);
    expect(buttonDisabled(markup, "common.delete")).toBe(false);
  });
});

describe("PartialPaymentInvoiceField", () => {
  const invoices: Array<{
    balance: number;
    code: string;
    id: string;
    period_month: number;
    period_year: number;
    state: InvoiceState;
  }> = [
    {
      id: "due",
      code: "INV-DUE",
      state: "due",
      balance: 100,
      period_year: 2026,
      period_month: 1,
    },
    {
      id: "paid",
      code: "INV-PAID",
      state: "paid",
      balance: 0,
      period_year: 2026,
      period_month: 2,
    },
    {
      id: "cancelled",
      code: "INV-CAN",
      state: "cancelled",
      balance: 80,
      period_year: 2026,
      period_month: 3,
    },
    {
      id: "zero",
      code: "INV-ZERO",
      state: "overdue",
      balance: 0,
      period_year: 2026,
      period_month: 4,
    },
  ];

  /**
   * الشرط الذي يحكم القائمة: مسدَّدة أو ملغاة أو بلا رصيد تخرج جميعها.
   *
   * Asserted on the predicate rather than on the rendered options, and that is
   * deliberate: `SelectContent` renders through a Radix portal that produces
   * nothing under `renderToStaticMarkup` — verified, not assumed. An
   * `expect(markup).not.toContain("INV-PAID")` therefore passes whether the
   * filter is present or deleted, which is worse than no test at all. The
   * component's own use of it is a single `invoices.filter(...)` call.
   */
  it("keeps paid, cancelled and zero-balance invoices out of the options", () => {
    const listed = invoices.filter(isSettleableForPartialLink).map((row) => row.code);
    expect(listed).toEqual(["INV-DUE"]);
  });

  it("renders the field without throwing on a mixed invoice list", () => {
    const markup = renderToStaticMarkup(
      <PartialPaymentInvoiceField invoices={invoices} value="" onChange={() => undefined} />,
    );
    expect(markup).toContain("partialPayments.invoice");
  });
});
