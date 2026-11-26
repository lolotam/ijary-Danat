import { beforeEach, describe, expect, test, vi } from "vitest";

const PAYMENT_SUPPRESSED = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ORDINARY = "22222222-2222-4222-8222-222222222222";
const INVOICE_SUPPRESSED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOICE_ORDINARY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTRACT_SUPPRESSED = "4382a1fe-db50-4bae-8360-58ec43ecf3c8";
// Distinct from every invoice id above: reusing one uuid for both an invoice and
// a contract would let a mixup between the two id kinds pass unnoticed.
const CONTRACT_ORDINARY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let allocationData: Array<{ payment_id: string; invoice_id: string }> = [];
let invoiceData: Array<{ id: string; contract_id: string | null }> = [];
let paymentData: Array<{ id: string; payment_request_id: string | null }> = [];
let requestData: Array<{ id: string; requested_invoice_ids: string[] }> = [];
let contractData: Array<{
  id: string;
  suppress_tenant_billing_docs: boolean | null;
  hide_from_portal?: boolean | null;
}> = [];

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: () => ({
    companyId: "11111111-1111-4111-8111-111111111111",
    client: {
      from: (table: string) => {
        if (table === "payment_allocations") {
          return {
            select: () => ({
              in: async () => ({ data: allocationData, error: null }),
            }),
          };
        }
        if (table === "invoices") {
          return {
            select: () => ({
              in: async () => ({ data: invoiceData, error: null }),
            }),
          };
        }
        if (table === "payments") {
          return { select: () => ({ in: async () => ({ data: paymentData, error: null }) }) };
        }
        if (table === "payment_requests") {
          return { select: () => ({ in: async () => ({ data: requestData, error: null }) }) };
        }
        if (table === "contracts") {
          return {
            select: () => ({
              in: async () => ({ data: contractData, error: null }),
            }),
          };
        }
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      },
    },
  }),
}));

const { getSuppressedPaymentIds } = await import("./suppressedPayments");

beforeEach(() => {
  allocationData = [];
  invoiceData = [];
  paymentData = [];
  requestData = [];
  contractData = [];
});

describe("getSuppressedPaymentIds", () => {
  test("payment touching a suppressed contract is returned", async () => {
    allocationData = [{ payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_SUPPRESSED }];
    invoiceData = [{ id: INVOICE_SUPPRESSED, contract_id: CONTRACT_SUPPRESSED }];
    contractData = [{ id: CONTRACT_SUPPRESSED, suppress_tenant_billing_docs: true }];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result).toEqual(new Set([PAYMENT_SUPPRESSED]));
  });

  test("payment touching only an ordinary contract returns empty", async () => {
    allocationData = [{ payment_id: PAYMENT_ORDINARY, invoice_id: INVOICE_ORDINARY }];
    invoiceData = [{ id: INVOICE_ORDINARY, contract_id: CONTRACT_ORDINARY }];
    contractData = [{ id: CONTRACT_ORDINARY, suppress_tenant_billing_docs: false }];

    const result = await getSuppressedPaymentIds([PAYMENT_ORDINARY]);
    expect(result.size).toBe(0);
  });

  test("mixed batch returns only the suppressed payment", async () => {
    allocationData = [
      { payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_SUPPRESSED },
      { payment_id: PAYMENT_ORDINARY, invoice_id: INVOICE_ORDINARY },
    ];
    invoiceData = [
      { id: INVOICE_SUPPRESSED, contract_id: CONTRACT_SUPPRESSED },
      { id: INVOICE_ORDINARY, contract_id: CONTRACT_ORDINARY },
    ];
    contractData = [
      { id: CONTRACT_SUPPRESSED, suppress_tenant_billing_docs: true },
      { id: CONTRACT_ORDINARY, suppress_tenant_billing_docs: false },
    ];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED, PAYMENT_ORDINARY]);
    expect(result).toEqual(new Set([PAYMENT_SUPPRESSED]));
  });

  test("a payment settling both a suppressed and an ordinary invoice is still suppressed (ANY)", async () => {
    allocationData = [
      { payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_SUPPRESSED },
      { payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_ORDINARY },
    ];
    invoiceData = [
      { id: INVOICE_SUPPRESSED, contract_id: CONTRACT_SUPPRESSED },
      { id: INVOICE_ORDINARY, contract_id: CONTRACT_ORDINARY },
    ];
    contractData = [
      { id: CONTRACT_SUPPRESSED, suppress_tenant_billing_docs: true },
      { id: CONTRACT_ORDINARY, suppress_tenant_billing_docs: false },
    ];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result).toEqual(new Set([PAYMENT_SUPPRESSED]));
  });

  /**
   * Review round 4 on PR #209. Migration 214's trigger hides the receipt at the
   * allocation, and then the MyFatoorah webhook's `makeReceiptsVisibleToTenant`
   * runs and flips it straight back — because it asks this helper, which read
   * only the older flag. `notifyPaymentSuccess` asks the same helper before
   * mailing the tenant the PDF. The trigger and this have to agree.
   */
  test("payment touching a portal-hidden contract is suppressed even when not billing-suppressed", async () => {
    allocationData = [{ payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_SUPPRESSED }];
    invoiceData = [{ id: INVOICE_SUPPRESSED, contract_id: CONTRACT_SUPPRESSED }];
    contractData = [
      {
        id: CONTRACT_SUPPRESSED,
        suppress_tenant_billing_docs: false,
        hide_from_portal: true,
      },
    ];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result).toEqual(new Set([PAYMENT_SUPPRESSED]));
  });

  // Neither flag set is the ordinary case, and it must stay unaffected.
  test("payment touching a contract with neither flag is not suppressed", async () => {
    allocationData = [{ payment_id: PAYMENT_ORDINARY, invoice_id: INVOICE_ORDINARY }];
    invoiceData = [{ id: INVOICE_ORDINARY, contract_id: CONTRACT_ORDINARY }];
    contractData = [
      { id: CONTRACT_ORDINARY, suppress_tenant_billing_docs: false, hide_from_portal: false },
    ];

    const result = await getSuppressedPaymentIds([PAYMENT_ORDINARY]);
    expect(result.size).toBe(0);
  });

  test("payment with no allocations is not suppressed", async () => {
    allocationData = [];
    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result.size).toBe(0);
  });

  /**
   * Phase 2C: a gateway `#EXCESS` payment is recorded unallocated, so it has no
   * allocation to trace. Without resolving it through its request, its receipt
   * would be flipped visible and the tenant mailed about a hidden contract.
   */
  test("an unallocated gateway excess on a portal-hidden contract is suppressed via its request", async () => {
    paymentData = [{ id: PAYMENT_SUPPRESSED, payment_request_id: "preq-roof" }];
    requestData = [{ id: "preq-roof", requested_invoice_ids: [INVOICE_SUPPRESSED] }];
    invoiceData = [{ id: INVOICE_SUPPRESSED, contract_id: CONTRACT_SUPPRESSED }];
    contractData = [
      { id: CONTRACT_SUPPRESSED, suppress_tenant_billing_docs: false, hide_from_portal: true },
    ];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result).toEqual(new Set([PAYMENT_SUPPRESSED]));
  });

  test("allocation whose invoice has null contract is not suppressed", async () => {
    allocationData = [{ payment_id: PAYMENT_SUPPRESSED, invoice_id: INVOICE_SUPPRESSED }];
    invoiceData = [{ id: INVOICE_SUPPRESSED, contract_id: null }];
    contractData = [];

    const result = await getSuppressedPaymentIds([PAYMENT_SUPPRESSED]);
    expect(result.size).toBe(0);
  });

  test("empty input returns empty without querying", async () => {
    const result = await getSuppressedPaymentIds([]);
    expect(result.size).toBe(0);
  });
});
