/**
 * One definition of "what a close-out statement is" — the HTML, the print CSS,
 * the tab title and the download filename.
 *
 * USE PATH A — openPrintableDocument (browser print). Reasons:
 * 1. The browser's own text engine is the only free path of the three that
 *    shapes and reorders Arabic correctly (joining forms + bidi).
 * 2. The html2canvas path needs `* { letter-spacing: normal !important }` or
 *    Arabic ligatures break apart per-glyph — a failure invisible in an English
 *    smoke test (see PDF_CAPTURE_CSS on printDocument.ts).
 * 3. Server pdfkit is WinAnsi and cannot render Arabic at all.
 * Path A also keeps the text selectable, which is the first thing an accountant
 * will try when verifying a figure.
 *
 * REPRODUCIBILITY: this builder reads ONLY the persisted contract_closeouts row
 * and its two child tables (deductions, invoice_actions) plus display labels
 * passed in by the caller. It NEVER recomputes totals from live invoices. A
 * statement reprinted in two years must show what was agreed then — that is
 * exactly why previous_state / resulting_state and the header totals are stored
 * columns. When header totals deliberately disagree with line sums, the HEADER
 * wins.
 */

import type { Company } from "@/hooks/useCompany";
import type { ContractCloseoutWithLines } from "@/hooks/useContractCloseouts";
import { type Locale, translatorFor } from "@/i18n/dictionary";
import { formatKwd } from "@/lib/money";
import { safeFilename } from "@/lib/safeFilename";

export interface CloseoutStatementDocument {
  html: string;
  title: string;
  filename: string;
  extraCss: string;
  dir: "rtl" | "ltr";
}

export type CloseoutStatementContract = {
  code: string;
  start_date: string;
  end_date: string;
  state?: string | null;
};

export type CloseoutStatementTenant = {
  name: string;
  code?: string | null;
};

export type CloseoutStatementUnit = {
  name: string;
  code?: string | null;
  property_name?: string | null;
};

export type CloseoutStatementInput = {
  closeout: ContractCloseoutWithLines;
  contract: CloseoutStatementContract;
  tenant: CloseoutStatementTenant;
  unit?: CloseoutStatementUnit | null;
  company?: Pick<Company, "name_ar" | "name_en" | "phone" | "logo_url"> | null;
  locale: Locale;
  /** Optional display name for completed_by; never required for money figures. */
  preparedByName?: string | null;
};

function esc(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function statementNumber(closeoutId: string): string {
  return `CO-${closeoutId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const OUTCOME_KEYS: readonly string[] = ["keep_terminated", "freeze", "archive"];

function outcomeLabel(outcome: string, locale: Locale): string {
  const t = translatorFor(locale);
  // Unknown values print raw, as they did when this was an inline map.
  return OUTCOME_KEYS.includes(outcome) ? t(`closeoutStatement.outcome.${outcome}`) : outcome;
}

const ACTION_KEYS: readonly string[] = [
  "leave",
  "settle_from_deposit",
  "write_off",
  "cancel",
  "mark_disputed",
];

function actionLabel(action: string, locale: Locale): string {
  const t = translatorFor(locale);
  // Unknown values print raw, as they did when this was an inline map.
  return ACTION_KEYS.includes(action) ? t(`closeoutStatement.action.${action}`) : action;
}

const DEDUCTION_KIND_KEYS: readonly string[] = [
  "damages",
  "cleaning",
  "utilities",
  "unpaid_rent",
  "other",
];

function deductionKindLabel(kind: string, locale: Locale): string {
  const t = translatorFor(locale);
  // Unknown values print raw, as they did when this was an inline map.
  return DEDUCTION_KIND_KEYS.includes(kind) ? t(`closeoutStatement.deductionKind.${kind}`) : kind;
}

function resultField(closeout: ContractCloseoutWithLines, key: string): string | null {
  const result = closeout.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[key];
  if (value == null) return null;
  return String(value);
}

const CLOSEOUT_PAGE_CSS = `
  .closeout-doc {
    padding: 10mm 12mm;
    color: #0f172a;
  }
  .closeout-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 2px solid #065f46;
    padding-bottom: 12px;
    margin-bottom: 14px;
  }
  .closeout-brand h1 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 800;
    color: #064e3b;
    line-height: 1.3;
  }
  .closeout-brand .code {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: #047857;
  }
  .closeout-brand .company {
    margin: 4px 0 0;
    font-size: 13px;
    color: #334155;
  }
  .closeout-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 20px;
    margin-bottom: 14px;
    font-size: 12px;
  }
  .closeout-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid #e2e8f0;
    padding: 6px 0;
  }
  .closeout-row .label { color: #64748b; }
  .closeout-row .value { font-weight: 600; text-align: end; }
  .closeout-section-title {
    margin: 16px 0 8px;
    font-size: 13px;
    font-weight: 800;
    color: #064e3b;
  }
  .closeout-table {
    width: 100%;
    font-size: 11px;
    border-collapse: collapse;
    margin-bottom: 10px;
  }
  .closeout-table th,
  .closeout-table td {
    border: 1px solid #e2e8f0;
    padding: 6px 5px;
    text-align: start;
    vertical-align: top;
  }
  .closeout-table th {
    background: #f0fdf4;
    font-weight: 700;
    color: #065f46;
  }
  .closeout-table td.num,
  .closeout-table th.num {
    text-align: end;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .closeout-totals {
    width: 100%;
    font-size: 12px;
    margin-top: 4px;
  }
  .closeout-totals td {
    padding: 7px 4px;
    border-bottom: 1px solid #e2e8f0;
  }
  .closeout-totals td:last-child {
    text-align: end;
    font-weight: 600;
    white-space: nowrap;
  }
  .closeout-totals tr.total td {
    border-bottom: 2px solid #065f46;
    padding-top: 10px;
    padding-bottom: 10px;
    font-size: 14px;
    font-weight: 800;
  }
  .closeout-notes {
    margin-top: 14px;
    padding: 10px;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    font-size: 11px;
    white-space: pre-wrap;
  }
  .closeout-footer {
    margin-top: 16px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    font-size: 11px;
    line-height: 1.5;
    color: #64748b;
  }
  @media print {
    .closeout-doc { padding: 0; }
  }
`;

export const closeoutStatementExtraCss = `
  @page { size: A4; margin: 10mm; }
  body { font-size: 12px; }
  .print-sheet { min-height: auto !important; box-shadow: none !important; }
`;

/**
 * Builds the bilingual close-out statement document.
 * Money figures come exclusively from the close-out header columns.
 */
export function closeoutStatementHtml(input: CloseoutStatementInput): CloseoutStatementDocument {
  const { closeout, contract, tenant, unit, company, locale, preparedByName } = input;
  const t = translatorFor(locale);
  const dir: "rtl" | "ltr" = locale === "ar" ? "rtl" : "ltr";
  const companyName =
    (locale === "ar"
      ? company?.name_ar || company?.name_en
      : company?.name_en || company?.name_ar) || t("closeoutStatement.danatAlMustaqbalRealEstate");

  const number = statementNumber(closeout.id);
  const L = {
    title: t("closeoutStatement.label.title"),
    statementNo: t("closeoutStatement.label.statementNo"),
    closeoutDate: t("closeoutStatement.label.closeoutDate"),
    tenant: t("closeoutStatement.label.tenant"),
    contract: t("closeoutStatement.label.contract"),
    property: t("closeoutStatement.label.property"),
    unit: t("closeoutStatement.label.unit"),
    term: t("closeoutStatement.label.term"),
    invoices: t("closeoutStatement.label.invoices"),
    invoice: t("closeoutStatement.label.invoice"),
    action: t("closeoutStatement.label.action"),
    previous: t("closeoutStatement.label.previous"),
    resulting: t("closeoutStatement.label.resulting"),
    amount: t("closeoutStatement.label.amount"),
    deductions: t("closeoutStatement.label.deductions"),
    kind: t("closeoutStatement.label.kind"),
    description: t("closeoutStatement.label.description"),
    paidTotal: t("closeoutStatement.label.paidTotal"),
    outstandingTotal: t("closeoutStatement.label.outstandingTotal"),
    depositCollected: t("closeoutStatement.label.depositCollected"),
    previousRefunds: t("closeoutStatement.label.previousRefunds"),
    refundAmount: t("closeoutStatement.label.refundAmount"),
    remainingBalance: t("closeoutStatement.label.remainingBalance"),
    contractOutcome: t("closeoutStatement.label.contractOutcome"),
    portalOutcome: t("closeoutStatement.label.portalOutcome"),
    unitOutcome: t("closeoutStatement.label.unitOutcome"),
    preparedBy: t("closeoutStatement.label.preparedBy"),
    completedAt: t("closeoutStatement.label.completedAt"),
    notes: t("closeoutStatement.label.notes"),
    notRecorded: t("closeoutStatement.label.notRecorded"),
    totals: t("closeoutStatement.label.totals"),
  };

  // HEADER totals win — never sum line items for these figures.
  const depositHeld = num(closeout.deposit_held);
  const settledTotal = num(closeout.settled_total);
  const writtenOffTotal = num(closeout.written_off_total);
  const refundTotal = num(closeout.refund_total);
  const balanceDue = num(closeout.balance_due_tenant);
  const deductionsTotal = num(closeout.deductions_total);

  const unitStatus = resultField(closeout, "unit_status");
  const tenantArchived = resultField(closeout, "tenant_archived");
  const archivedAt = resultField(closeout, "archived_at");
  const portalOutcome =
    closeout.outcome === "archive" || tenantArchived === "true"
      ? t("closeoutStatement.portalDisabled")
      : t("closeoutStatement.noPortalChangeViaClose");

  const unitOutcome = unitStatus ? unitStatus : "—";

  const contractOutcomeParts = [
    outcomeLabel(closeout.outcome, locale),
    closeout.final_contract_state,
    archivedAt ? t("closeoutStatement.archived") : t("closeoutStatement.visibleInLists"),
  ].join(" · ");

  const invoiceRows = (closeout.invoiceActions ?? [])
    .map((row) => {
      // Prefer public invoice code when the stored result jsonb carries it;
      // never re-fetch live invoices for money. Code is a display label only.
      let invoiceLabel = row.invoice_id.slice(0, 8);
      const result = closeout.result;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const actions = (result as Record<string, unknown>).invoice_actions;
        if (Array.isArray(actions)) {
          const match = actions.find(
            (a) =>
              a &&
              typeof a === "object" &&
              (a as Record<string, unknown>).invoice_id === row.invoice_id,
          ) as Record<string, unknown> | undefined;
          if (match?.invoice_code) invoiceLabel = String(match.invoice_code);
        }
      }
      return `
      <tr>
        <td>${esc(invoiceLabel)}</td>
        <td>${esc(actionLabel(row.action, locale))}</td>
        <td>${esc(row.previous_state)}</td>
        <td>${esc(row.resulting_state)}</td>
        <td class="num">${esc(formatKwd(num(row.amount), locale))}</td>
      </tr>`;
    })
    .join("");

  const deductionRows = (closeout.deductions ?? [])
    .map((row) => {
      const desc =
        locale === "ar"
          ? row.description_ar || row.description_en
          : row.description_en || row.description_ar;
      return `
      <tr>
        <td>${esc(deductionKindLabel(row.kind, locale))}</td>
        <td>${esc(desc)}</td>
        <td class="num">${esc(formatKwd(num(row.amount), locale))}</td>
      </tr>`;
    })
    .join("");

  const metaRows = [
    { label: L.statementNo, value: number },
    {
      label: L.closeoutDate,
      value: closeout.completed_at?.slice(0, 10) ?? closeout.move_out_date,
    },
    {
      label: L.tenant,
      value: tenant.code ? `${tenant.name} (${tenant.code})` : tenant.name,
    },
    { label: L.contract, value: contract.code },
    { label: L.property, value: unit?.property_name ?? "—" },
    {
      label: L.unit,
      value: unit ? (unit.code ? `${unit.name} (${unit.code})` : unit.name) : "—",
    },
    { label: L.term, value: `${contract.start_date} → ${contract.end_date}` },
  ];

  const html = `
<style>${CLOSEOUT_PAGE_CSS}</style>
<article class="closeout-doc" dir="${dir}" lang="${locale === "ar" ? "ar" : "en"}">
  <header class="closeout-header">
    <div class="closeout-brand">
      <p class="code">${esc(number)}</p>
      <h1>${esc(L.title)}</h1>
      <p class="company">${esc(companyName)}</p>
    </div>
  </header>

  <section class="closeout-grid">
    ${metaRows
      .map(
        (row) => `
      <div class="closeout-row">
        <span class="label">${esc(row.label)}</span>
        <span class="value">${esc(row.value)}</span>
      </div>`,
      )
      .join("")}
  </section>

  <h2 class="closeout-section-title">${esc(L.invoices)}</h2>
  <table class="closeout-table">
    <thead>
      <tr>
        <th>${esc(L.invoice)}</th>
        <th>${esc(L.action)}</th>
        <th>${esc(L.previous)}</th>
        <th>${esc(L.resulting)}</th>
        <th class="num">${esc(L.amount)}</th>
      </tr>
    </thead>
    <tbody>
      ${
        invoiceRows || `<tr><td colspan="5">${esc(t("closeoutStatement.noInvoiceLines"))}</td></tr>`
      }
    </tbody>
  </table>

  <h2 class="closeout-section-title">${esc(L.deductions)}</h2>
  <table class="closeout-table">
    <thead>
      <tr>
        <th>${esc(L.kind)}</th>
        <th>${esc(L.description)}</th>
        <th class="num">${esc(L.amount)}</th>
      </tr>
    </thead>
    <tbody>
      ${
        deductionRows || `<tr><td colspan="3">${esc(t("closeoutStatement.noDeductions"))}</td></tr>`
      }
    </tbody>
  </table>

  <h2 class="closeout-section-title">${esc(L.totals)}</h2>
  <table class="closeout-totals">
    <tbody>
      <tr>
        <td>${esc(L.depositCollected)}</td>
        <td>${esc(formatKwd(depositHeld, locale))}</td>
      </tr>
      <tr>
        <td>${esc(L.previousRefunds)}</td>
        <td>${esc(L.notRecorded)}</td>
      </tr>
      <tr>
        <td>${esc(t("closeoutStatement.deductionsTotal"))}</td>
        <td>${esc(formatKwd(deductionsTotal, locale))}</td>
      </tr>
      <tr>
        <td>${esc(L.paidTotal)}</td>
        <td>${esc(formatKwd(settledTotal, locale))}</td>
      </tr>
      <tr>
        <td>${esc(L.outstandingTotal)}</td>
        <td>${esc(formatKwd(writtenOffTotal, locale))}</td>
      </tr>
      <tr>
        <td>${esc(L.refundAmount)}</td>
        <td>${esc(formatKwd(refundTotal, locale))}</td>
      </tr>
      <tr class="total">
        <td>${esc(L.remainingBalance)}</td>
        <td>${esc(formatKwd(balanceDue, locale))}</td>
      </tr>
    </tbody>
  </table>

  <section class="closeout-grid" style="margin-top:14px">
    <div class="closeout-row">
      <span class="label">${esc(L.contractOutcome)}</span>
      <span class="value">${esc(contractOutcomeParts)}</span>
    </div>
    <div class="closeout-row">
      <span class="label">${esc(L.portalOutcome)}</span>
      <span class="value">${esc(portalOutcome)}</span>
    </div>
    <div class="closeout-row">
      <span class="label">${esc(L.unitOutcome)}</span>
      <span class="value">${esc(unitOutcome)}</span>
    </div>
    <div class="closeout-row">
      <span class="label">${esc(L.preparedBy)}</span>
      <span class="value">${esc(preparedByName ?? closeout.completed_by ?? "—")}</span>
    </div>
    <div class="closeout-row">
      <span class="label">${esc(L.completedAt)}</span>
      <span class="value">${esc(closeout.completed_at)}</span>
    </div>
  </section>

  ${
    closeout.note
      ? `<div class="closeout-notes"><strong>${esc(L.notes)}:</strong> ${esc(closeout.note)}</div>`
      : ""
  }

  <footer class="closeout-footer">
    ${esc(companyName)}${company?.phone ? ` · ${esc(company.phone)}` : ""}
  </footer>
</article>
`;

  return {
    html,
    title: `${number} — ${companyName}`,
    filename: `${safeFilename(number)}.pdf`,
    extraCss: closeoutStatementExtraCss,
    dir,
  };
}
