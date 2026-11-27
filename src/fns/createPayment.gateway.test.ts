import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID = "44444444-4444-4444-8444-444444444444";

const loadActiveGatewayConnectionMock = vi.hoisted(() => vi.fn());
const insertedPayloads = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const updatedPayloads = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: unknown) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: unknown) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({ server: (m: unknown) => m }),
  };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  getRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadActiveGatewayConnection: (...args: unknown[]) => loadActiveGatewayConnectionMock(...args),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      if (table !== "payment_requests") {
        throw new Error(`Unexpected company table: ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          insertedPayloads.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: "preq-1",
                  code: "PREQ-0000001",
                  requested_invoice_ids: row.requested_invoice_ids,
                  amount: row.amount,
                  gateway: row.gateway ?? "myfatoorah",
                },
                error: null,
              }),
            }),
          };
        },
        update: (row: Record<string, unknown>) => {
          updatedPayloads.push(row);
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: { code: "PREQ-0000001", payment_url: "https://pay.test/1" },
                  error: null,
                }),
              }),
            }),
          };
        },
      };
    },
  }),
}));

import { createPayment, NO_ACTIVE_GATEWAY } from "./createPayment";

function buildUserContext() {
  return {
    userId: "user-1",
    supabase: {
      from: (table: string) => {
        if (table === "invoices") {
          return {
            select: () => ({
              in: async () => ({ data: [{ tenant_id: TENANT_ID }], error: null }),
            }),
          };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { tenant_id: TENANT_ID }, error: null }),
              }),
            }),
          };
        }
        if (table === "tenants") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: TENANT_ID,
                    company_id: COMPANY_ID,
                    name: "Renter",
                    tenant_portal_enabled: true,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "companies") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { portal_apple_pay_enabled: true, portal_google_pay_enabled: true },
                  error: null,
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      rpc: async (name: string) => {
        if (name === "evaluate_portal_payable_invoices") {
          return {
            data: [
              {
                invoice_id: INVOICE_ID,
                balance: 100,
                is_selectable: true,
                period_month: 1,
                period_year: 2026,
              },
            ],
            error: null,
          };
        }
        if (name === "write_audit") {
          return { data: null, error: null };
        }
        throw new Error(`Unexpected rpc: ${name}`);
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedPayloads.length = 0;
  updatedPayloads.length = 0;
  (createPayment as unknown as { _context: unknown })._context = buildUserContext();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPayment gateway connection binding (T144)", () => {
  it("refuses with NO_ACTIVE_GATEWAY when company has no active gateway connection", async () => {
    loadActiveGatewayConnectionMock.mockResolvedValue(null);

    await expect((createPayment as any)({ invoiceIds: [INVOICE_ID] })).rejects.toThrow(
      NO_ACTIVE_GATEWAY,
    );
    expect(insertedPayloads).toHaveLength(0);
  });

  it("creates payment via active connection and stores gateway_connection_id and credentials_version", async () => {
    loadActiveGatewayConnectionMock.mockResolvedValue({
      id: CONNECTION_ID,
      companyId: COMPANY_ID,
      provider: "myfatoorah",
      mode: "test",
      isActive: true,
      credentialsVersion: 3,
      connection: {
        provider: "myfatoorah",
        mode: "test",
        credentials: { apiKey: "mf_company_key" },
        publicConfig: {},
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          IsSuccess: true,
          Data: { InvoiceId: "MF-999", PaymentURL: "https://pay.test/1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await (createPayment as any)({
      invoiceIds: [INVOICE_ID],
      paymentMethod: "KNET",
    });

    expect(result).toEqual({
      paymentUrl: "https://pay.test/1",
      paymentRequestCode: "PREQ-0000001",
    });
    expect(insertedPayloads[0]).toMatchObject({
      gateway: "myfatoorah",
      gateway_connection_id: CONNECTION_ID,
      credentials_version: 3,
    });
    expect(updatedPayloads[0]).toMatchObject({
      gateway: "myfatoorah",
      gateway_connection_id: CONNECTION_ID,
      credentials_version: 3,
      provider_invoice_id: "MF-999",
    });
  });
});
