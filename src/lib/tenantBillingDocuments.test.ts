import { describe, expect, test } from "vitest";

import {
  filterPrintableInvoices,
  shouldShowTenantBillingActions,
  shouldSuppressTenantNotification,
  suppressedContractIdsFromRows,
} from "./tenantBillingDocuments";

const ROOF_CONTRACT = "4382a1fe-db50-4bae-8360-58ec43ecf3c8";
const SHOP_CONTRACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SHOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function invoice(contractId: string | null) {
  return { contract_id: contractId, id: `inv-${contractId ?? "null"}` } as {
    contract_id: string | null;
    id: string;
  };
}

describe("suppressedContractIdsFromRows", () => {
  test("collects only explicit true", () => {
    const ids = suppressedContractIdsFromRows([
      { id: ROOF_CONTRACT, suppress_tenant_billing_docs: true },
      { id: SHOP_CONTRACT, suppress_tenant_billing_docs: false },
      { id: OTHER_SHOP, suppress_tenant_billing_docs: null },
    ]);
    expect(ids).toEqual(new Set([ROOF_CONTRACT]));
  });

  test("absent flag is treated as not suppressed", () => {
    // Build fixtures literally without the key — a helper that defaults the flag
    // would make this pass even when the code is broken (caught in review).
    const rows: { id: string; suppress_tenant_billing_docs?: boolean | null }[] = [
      { id: ROOF_CONTRACT },
      { id: SHOP_CONTRACT, suppress_tenant_billing_docs: undefined },
    ];
    const ids = suppressedContractIdsFromRows(rows);
    expect(ids.size).toBe(0);
  });
});

describe("filterPrintableInvoices", () => {
  test("a payment settling only suppressed invoices leaves nothing printable", () => {
    const suppressed = new Set([ROOF_CONTRACT]);
    const result = filterPrintableInvoices(
      [invoice(ROOF_CONTRACT), invoice(ROOF_CONTRACT)],
      suppressed,
    );
    expect(result).toEqual([]);
  });

  test("a payment settling only ordinary invoices is unchanged", () => {
    const suppressed = new Set([ROOF_CONTRACT]);
    const result = filterPrintableInvoices(
      [invoice(SHOP_CONTRACT), invoice(OTHER_SHOP)],
      suppressed,
    );
    expect(result).toHaveLength(2);
  });

  test("mixed payment keeps only the ordinary invoice", () => {
    const suppressed = new Set([ROOF_CONTRACT]);
    const result = filterPrintableInvoices(
      [invoice(ROOF_CONTRACT), invoice(SHOP_CONTRACT)],
      suppressed,
    );
    expect(result.map((inv) => inv.contract_id)).toEqual([SHOP_CONTRACT]);
  });

  test("invoice with null contract is kept", () => {
    const suppressed = new Set([ROOF_CONTRACT]);
    const result = filterPrintableInvoices([invoice(null)], suppressed);
    expect(result).toHaveLength(1);
  });
});

describe("shouldShowTenantBillingActions — portal render rule", () => {
  test("payment settling only suppressed invoices renders no actions", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [invoice(ROOF_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(false);
  });

  test("payment settling only ordinary invoices still renders actions", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [invoice(SHOP_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(true);
  });

  test("mixed payment still renders actions — the document will filter down", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [invoice(ROOF_CONTRACT), invoice(SHOP_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(true);
    // And the document itself contains only the ordinary invoice.
    const printable = filterPrintableInvoices(
      [invoice(ROOF_CONTRACT), invoice(SHOP_CONTRACT)],
      new Set([ROOF_CONTRACT]),
    );
    expect(printable).toEqual([invoice(SHOP_CONTRACT)]);
  });

  test("flag absent on the contract means not suppressed", () => {
    // Simulate stale cache: no ids in the suppressed set.
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [invoice(ROOF_CONTRACT)],
        suppressedContractIds: new Set(),
      }),
    ).toBe(true);
  });

  test("allocation-less payment on a suppressed contract shows no actions", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
        isAllocationlessSuppressed: true,
      }),
    ).toBe(false);
  });

  test("allocation-less payment on an ordinary contract still shows actions", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
        isAllocationlessSuppressed: false,
      }),
    ).toBe(true);
  });

  test("allocation-less with no contract resolution keeps actions", () => {
    expect(
      shouldShowTenantBillingActions({
        settledInvoices: [],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
        isAllocationlessSuppressed: null,
      }),
    ).toBe(true);
  });
});

describe("shouldSuppressTenantNotification — server notification rule (ANY suppressed -> suppress)", () => {
  test("payment on a suppressed contract suppresses tenant notification", () => {
    expect(
      shouldSuppressTenantNotification({
        settledInvoices: [invoice(ROOF_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(true);
  });

  test("ordinary payment does not suppress", () => {
    expect(
      shouldSuppressTenantNotification({
        settledInvoices: [invoice(SHOP_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(false);
  });

  test("mixed payment suppresses tenant notification — unlike the portal, ANY suppressed drops the whole notification", () => {
    // Portal keeps actions and filters the document; the emailed PDF cannot be
    // filtered (one document per payment), so the whole tenant notification goes.
    expect(
      shouldSuppressTenantNotification({
        settledInvoices: [invoice(ROOF_CONTRACT), invoice(SHOP_CONTRACT)],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(true);
  });

  test("empty settled invoices does not suppress", () => {
    expect(
      shouldSuppressTenantNotification({
        settledInvoices: [],
        suppressedContractIds: new Set([ROOF_CONTRACT]),
      }),
    ).toBe(false);
  });
});
