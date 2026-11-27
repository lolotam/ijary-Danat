import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, it, expect, vi } from "vitest";

// Mock createServerFn before importing the module under test
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => {
    return fn._handler({ data, context: fn._context });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => adminMock,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "company-123",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  getRequestCompany: () => ({
    id: "company-123",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

// Every company in this suite has one active MyFatoorah test connection; the
// connection-binding rules themselves are covered in createPayment.gateway.test.ts.
vi.mock("@/gateways/connectionStore.server", () => ({
  loadActiveGatewayConnection: async () => ({
    id: "connection-123",
    companyId: "company-123",
    provider: "myfatoorah",
    mode: "test",
    isActive: true,
    credentialsVersion: 1,
    connection: {
      provider: "myfatoorah",
      mode: "test",
      credentials: { apiKey: "test-api-key" },
      publicConfig: {},
    },
  }),
}));

const supabaseAdmin = adminMock;
import {
  assertPortalMethodEnabled,
  buildHostedPaymentPayload,
  createPayment,
  inputSchema,
} from "./createPayment";

// A request created "just now": the reuse branch only hands back links younger
// than PAYMENT_LINK_TTL_HOURS, so every fixture meaning "reuse" carries one.
const FRESH_CREATED_AT = new Date().toISOString();

const mockTenantQuery = {
  data: { id: "tenant-123", company_id: "company-123", tenant_portal_enabled: true },
  error: null,
};

// Shared mock database client helper.
// `callerTenantId` is the tenant on the caller's own profile — null models a
// staff user, whose payment authorization comes from has_permission instead.
const createMockSupabase = (
  mockRpc: any,
  callerTenantId: string | null = "tenant-123",
  // Both extras on — the production default, so the payment-method rule is a
  // no-op for every test that is not specifically about it.
  companyFlags: { applePay: boolean; googlePay: boolean } = { applePay: true, googlePay: true },
) => ({
  from: vi.fn().mockImplementation((table) => {
    if (table === "invoices") {
      return {
        select: () => ({
          // The handler derives the paying tenant from the selected invoices.
          in: (_column: string, ids: string[]) =>
            Promise.resolve({
              data: ids.map(() => ({ tenant_id: "tenant-123" })),
              error: null,
            }),
        }),
      };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { tenant_id: callerTenantId, company_id: "company-123", is_active: true },
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ role: "tenant" }],
              error: null,
            }),
        }),
      };
    }
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve(mockTenantQuery),
          }),
        }),
      };
    }
    if (table === "companies") {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: {
                  portal_apple_pay_enabled: companyFlags.applePay,
                  portal_google_pay_enabled: companyFlags.googlePay,
                },
                error: null,
              }),
          }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    };
  }),
  rpc: mockRpc,
});

describe("createPayment chronological validation", () => {
  it("accepts a contract-scoped selection while another contract has older arrears", async () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    // Tenant-wide list would put janA first; contract B's RPC returns only aprB, mayB.
    const mockRpc = vi
      .fn()
      .mockImplementation((rpcName: string, args?: { p_contract_id?: string }) => {
        if (rpcName === "evaluate_portal_payable_invoices") {
          if (args?.p_contract_id === "contract-b") {
            return {
              data: [
                { invoice_id: "apr-b", balance: 100, is_selectable: true },
                { invoice_id: "may-b", balance: 100, is_selectable: true },
              ],
              error: null,
            };
          }
          return {
            data: [
              { invoice_id: "jan-a", balance: 50, is_selectable: true },
              { invoice_id: "apr-b", balance: 100, is_selectable: true },
              { invoice_id: "may-b", balance: 100, is_selectable: true },
            ],
            error: null,
          };
        }
        return { data: null, error: null };
      });

    // Reuse a pending link so we do not need a live gateway call — the point of
    // this test is the prefix check, not MyFatoorah.
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: {
        status: "pending",
        payment_url: "https://myfatoorah.com/pay-b",
        created_at: FRESH_CREATED_AT,
        gateway_connection_id: "connection-123",
        credentials_version: 1,
        code: "PREQ-CB",
        amount: 200,
      },
      error: null,
    });

    const mockSupabase = createMockSupabase(mockRpc);
    const gFn = createPayment as any;
    gFn._context = { supabase: mockSupabase, userId: "test-user-id" };

    const result = await gFn({ invoiceIds: ["apr-b", "may-b"], contractId: "contract-b" });
    delete process.env.MYFATOORAH_API_KEY;
    expect(result.paymentUrl).toBe("https://myfatoorah.com/pay-b");
    expect(mockRpc).toHaveBeenCalledWith(
      "evaluate_portal_payable_invoices",
      expect.objectContaining({ p_contract_id: "contract-b" }),
    );
  });

  it("still rejects an out-of-order selection within the chosen contract", async () => {
    const mockRpc = vi
      .fn()
      .mockImplementation((rpcName: string, args?: { p_contract_id?: string }) => {
        if (rpcName === "evaluate_portal_payable_invoices") {
          if (args?.p_contract_id === "contract-b") {
            return {
              data: [
                { invoice_id: "apr-b", balance: 100, is_selectable: true },
                { invoice_id: "may-b", balance: 100, is_selectable: true },
              ],
              error: null,
            };
          }
          return { data: [], error: null };
        }
        return { data: null, error: null };
      });

    const mockSupabase = createMockSupabase(mockRpc);
    mockSupabase.rpc = mockRpc;
    const gFn = createPayment as any;
    gFn._context = { supabase: mockSupabase, userId: "test-user-id" };

    await expect(gFn({ invoiceIds: ["may-b"], contractId: "contract-b" })).rejects.toThrow(
      /chronological/i,
    );
  });

  it("keeps today's tenant-wide ordering when no contract is given", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [
            { invoice_id: "jan-a", balance: 50, is_selectable: true },
            { invoice_id: "apr-b", balance: 100, is_selectable: true },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const mockSupabase = createMockSupabase(mockRpc);
    mockSupabase.rpc = mockRpc;
    const gFn = createPayment as any;
    gFn._context = { supabase: mockSupabase, userId: "test-user-id" };

    await expect(gFn({ invoiceIds: ["apr-b"] })).rejects.toThrow(/chronological/i);
    // `p_include_hidden` is sent unconditionally; migration 210's RPC downgrades
    // it for a tenant caller, so the admin's manual KNET link keeps working for
    // a hidden roof invoice while a tenant still cannot pay one.
    expect(mockRpc).toHaveBeenCalledWith("evaluate_portal_payable_invoices", {
      p_tenant_id: "tenant-123",
      p_include_hidden: true,
    });
  });

  it("throws 409 if the first payable invoice is not selectable", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [
            { invoice_id: "inv-1", balance: 50, is_selectable: false },
            { invoice_id: "inv-2", balance: 100, is_selectable: true },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const mockSupabase = createMockSupabase(mockRpc);
    const gFn = createPayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(gFn({ invoiceIds: ["inv-2"] })).rejects.toThrow(/chronological/i);
  });

  it("throws 409 if invoices are selected out of order", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [
            { invoice_id: "inv-1", balance: 50, is_selectable: true },
            { invoice_id: "inv-2", balance: 100, is_selectable: true },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const mockSupabase = createMockSupabase(mockRpc);
    const gFn = createPayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    // Selecting only inv-2 (skipping inv-1) should fail
    await expect(gFn({ invoiceIds: ["inv-2"] })).rejects.toThrow(/chronological/i);
  });

  it("rejects with Error when no payable balance remains", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [{ invoice_id: "inv-1", balance: 0, is_selectable: true }],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const mockSupabase = createMockSupabase(mockRpc);
    const gFn = createPayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(gFn({ invoiceIds: ["inv-1"] })).rejects.toThrow(Error);
    await expect(gFn({ invoiceIds: ["inv-1"] })).rejects.toThrow(/payable balance/i);
  });

  it("succeeds if invoices are selected in correct chronological prefix order", async () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [
            { invoice_id: "inv-1", balance: 50, is_selectable: true },
            { invoice_id: "inv-2", balance: 100, is_selectable: true },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    // Mock reservePaymentRequest database queries inside createPayment.
    // amount must match selection total (50+100) or the pending URL is treated as stale.
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: {
        status: "pending",
        payment_url: "https://myfatoorah.com/pay",
        created_at: FRESH_CREATED_AT,
        gateway_connection_id: "connection-123",
        credentials_version: 1,
        code: "PAY-1",
        amount: 150,
      },
      error: null,
    });

    const mockSupabase = createMockSupabase(mockRpc);
    const gFn = createPayment as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    // Selecting inv-1 and inv-2 (correct order)
    const result = await gFn({ invoiceIds: ["inv-1", "inv-2"] });
    delete process.env.MYFATOORAH_API_KEY;
    expect(result.paymentUrl).toBe("https://myfatoorah.com/pay");
    expect(result.paymentRequestCode).toBe("PAY-1");
  });
});

describe("createPayment authorization", () => {
  const payableRpc = (hasPermission: boolean) =>
    vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return {
          data: [{ invoice_id: "inv-1", balance: 50, is_selectable: true }],
          error: null,
        };
      }
      if (rpcName === "has_permission") return { data: hasPermission, error: null };
      return { data: null, error: null };
    });

  const supabaseFor = (callerTenantId: string | null, hasPermission: boolean) => ({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "invoices") {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) =>
              Promise.resolve({ data: ids.map(() => ({ tenant_id: "tenant-123" })), error: null }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { tenant_id: callerTenantId }, error: null }),
            }),
          }),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: "tenant-123",
                    company_id: "company-123",
                    tenant_portal_enabled: true,
                  },
                  error: null,
                }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
        }),
      };
    }),
    rpc: payableRpc(hasPermission),
  });

  const callWith = (callerTenantId: string | null, hasPermission: boolean) => {
    const gFn = createPayment as any;
    gFn._context = { supabase: supabaseFor(callerTenantId, hasPermission), userId: "user-1" };
    return gFn({ invoiceIds: ["inv-1"] });
  };

  it("rejects a caller who is neither the invoices' tenant nor permitted", async () => {
    // Another tenant's account must not be able to pay these invoices.
    // Must be Error (not Response): a Response resolves client-side as success.
    await expect(callWith("someone-else", false)).rejects.toThrow(Error);
    await expect(callWith("someone-else", false)).rejects.toThrow(/not authorized/i);
  });

  it("lets staff without a linked tenant pay when they hold payment_links.create", async () => {
    // Staff profiles have tenant_id = null; keying authorization off that column
    // alone used to make the admin-on-behalf path impossible.
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: {
        status: "pending",
        payment_url: "https://myfatoorah.com/pay",
        created_at: FRESH_CREATED_AT,
        gateway_connection_id: "connection-123",
        credentials_version: 1,
        code: "PAY-2",
        amount: 50,
      },
      error: null,
    });
    const result = await callWith(null, true);
    delete process.env.MYFATOORAH_API_KEY;
    expect(result.paymentUrl).toBe("https://myfatoorah.com/pay");
  });

  it("records a refused non-owner in the audit trail against the tenant", async () => {
    const supabase = supabaseFor("someone-else", false);
    const gFn = createPayment as any;
    gFn._context = { supabase, userId: "user-1" };

    await expect(gFn({ invoiceIds: ["inv-1"] })).rejects.toThrow(/not authorized/i);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_entity_type: "tenant",
        p_entity_id: "tenant-123",
        p_error_code: "FORBIDDEN",
        p_after: { attempted: "payment.create_link", permission: "payment_links.create" },
      }),
    );
  });

  it("never asks the owning tenant for a permission, so records nothing", async () => {
    const supabase = supabaseFor("tenant-123", false);
    const gFn = createPayment as any;
    gFn._context = { supabase, userId: "user-1" };

    await gFn({ invoiceIds: ["inv-1"] }).catch(() => undefined);
    expect(supabase.rpc).not.toHaveBeenCalledWith("has_permission", expect.anything());
    expect(supabase.rpc).not.toHaveBeenCalledWith("write_audit", expect.anything());
  });

  it("rejects staff without payment_links.create", async () => {
    await expect(callWith(null, false)).rejects.toThrow(Error);
    await expect(callWith(null, false)).rejects.toThrow(/permission to create payment/i);
  });
});

describe("createPayment never throws Response", () => {
  // Guard: a revert of the Error-not-Response fix keeps all behavioural tests
  // green (bare toThrow / status matchers accept either) while restoring the
  // silent-success toast bug. This source assertion makes that impossible.
  it("source has no throw new Response", () => {
    const source = readFileSync(join(process.cwd(), "src/fns/createPayment.ts"), "utf8");
    expect(source).not.toMatch(/throw\s+new\s+Response/);
  });
});

describe("buildHostedPaymentPayload — T4 KNET restriction", () => {
  const base = {
    amount: 150,
    paymentRequestCode: "PAY-1",
    redirectUrl: "https://danat-future.com/portal/payments/callback/PAY-1",
    tenantName: "شركة الاختبار",
    tenantId: "tenant-123",
  };

  it("omits PaymentMethod entirely when no method is requested", () => {
    // MyFatoorah reads an ABSENT PaymentMethod as "show every enabled method".
    // A key present with a null/undefined value is not the same thing, so this
    // asserts absence rather than falsiness.
    const payload = buildHostedPaymentPayload(base);
    expect("PaymentMethod" in payload).toBe(false);
  });

  it("sends PaymentMethod: KNET when a KNET link is requested", () => {
    const payload = buildHostedPaymentPayload({ ...base, paymentMethod: "KNET" });
    expect(payload).toMatchObject({ PaymentMethod: "KNET" });
  });

  // MyFatoorah spells these with an underscore. `APPLEPAY` / `GOOGLEPAY` are
  // rejected by the gateway at request time, and the failure surfaces as a
  // generic "request failed" — so pin the exact wire values here.
  it.each([["GOOGLE_PAY"], ["APPLE_PAY"]] as const)(
    "sends PaymentMethod: %s when that method is requested",
    (method) => {
      const payload = buildHostedPaymentPayload({ ...base, paymentMethod: method });
      expect(payload).toMatchObject({ PaymentMethod: method });
    },
  );

  it("restricting the method changes nothing else about the request", () => {
    const generic = buildHostedPaymentPayload(base);
    const knet = buildHostedPaymentPayload({ ...base, paymentMethod: "KNET" });
    expect({ ...knet, PaymentMethod: undefined }).toEqual({ ...generic, PaymentMethod: undefined });
    expect(knet.Order).toEqual({ Amount: 150, Currency: "KWD" });
    expect(knet.IntegrationUrls.Redirection).toBe(base.redirectUrl);
  });
});

describe("createPayment input schema", () => {
  // The createServerFn mock at the top of this file returns the handler without
  // ever running .validator(), so calling the server function proves nothing
  // about the schema. These assert it directly.
  const validIds = { invoiceIds: ["11111111-1111-4111-8111-111111111111"] };

  it.each(["KNET", "GOOGLE_PAY", "APPLE_PAY"])("accepts %s", (method) => {
    expect(inputSchema.safeParse({ ...validIds, paymentMethod: method }).success).toBe(true);
  });

  it("accepts an omitted method, which means 'show every enabled method'", () => {
    expect(inputSchema.safeParse(validIds).success).toBe(true);
  });

  it.each(["CARD", "APPLEPAY", "GOOGLEPAY", "STC_PAY", "knet"])("rejects %s", (method) => {
    // CARD is excluded by product decision; the rest are misspellings or methods
    // the account has not enabled. Rejecting here beats failing at the gateway.
    expect(inputSchema.safeParse({ ...validIds, paymentMethod: method }).success).toBe(false);
  });
});

describe("createPayment honours a switched payment method", () => {
  // Torn down here rather than at the end of each test: a failing assertion would
  // otherwise leave `fetch` stubbed for every test that runs after it, turning one
  // real failure into a cascade of misleading ones.
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MYFATOORAH_API_KEY;
  });

  const singlePayableRpc = () =>
    vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return { data: [{ invoice_id: "inv-1", balance: 50, is_selectable: true }], error: null };
      }
      return { data: null, error: null };
    });

  const pendingKnetLink = {
    id: "preq-1",
    status: "pending",
    payment_url: "https://myfatoorah.com/knet-link",
    created_at: FRESH_CREATED_AT,
    gateway_connection_id: "connection-123",
    credentials_version: 1,
    code: "PREQ-0000009",
    amount: 50,
    request_payload: { PaymentMethod: "KNET" },
  };

  function callWithMethod(paymentMethod?: string) {
    const gFn = createPayment as any;
    gFn._context = { supabase: createMockSupabase(singlePayableRpc()), userId: "test-user-id" };
    return gFn({ invoiceIds: ["inv-1"], ...(paymentMethod ? { paymentMethod } : {}) });
  }

  it("reuses the existing link when the same method is asked for again", async () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: pendingKnetLink,
      error: null,
    });

    const result = await callWithMethod("KNET");

    expect(result.paymentUrl).toBe("https://myfatoorah.com/knet-link");
    // Reuse means no second MyFatoorah invoice, which is the property that stops
    // the same money being payable through two live links at once.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-issues on a new request row when the tenant switches method", async () => {
    // A pinned link jumps straight to one provider, so handing back the KNET URL
    // to a tenant who just picked Google Pay lands them on the wrong page.
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          IsSuccess: true,
          Data: { InvoiceId: 42, PaymentURL: "https://myfatoorah.com/googlepay-link" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: pendingKnetLink,
      error: null,
    });
    vi.mocked((supabaseAdmin as any).single)
      // the new request row inserted after the KNET one is superseded …
      .mockResolvedValueOnce({
        data: { ...pendingKnetLink, id: "preq-2", payment_url: null },
        error: null,
      })
      // … then saveGatewayExecution storing the freshly-issued one
      .mockResolvedValueOnce({
        data: { code: "PREQ-0000009", payment_url: "https://myfatoorah.com/googlepay-link" },
        error: null,
      });

    const result = await callWithMethod("GOOGLE_PAY");

    expect(result.paymentUrl).toBe("https://myfatoorah.com/googlepay-link");
    expect(result.paymentRequestCode).toBe("PREQ-0000009");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.PaymentMethod).toBe("GOOGLE_PAY");
    // The KNET link is not overwritten: its row is superseded and keeps its
    // provider ids, because that link can still be paid (migration 223).
    expect((supabaseAdmin as any).update).toHaveBeenCalledWith({
      idempotency_key: null,
      status: "superseded",
    });
  });
});

describe("assertPortalMethodEnabled", () => {
  it("passes a method the admin left enabled", () => {
    expect(() =>
      assertPortalMethodEnabled({ enabled: ["KNET", "GOOGLE_PAY"], method: "GOOGLE_PAY" }),
    ).not.toThrow();
  });

  it("throws an Error, not a Response, for a disabled method", () => {
    // A thrown Response is delivered to the client as a resolved value via
    // x-tss-raw, so the portal would read this refusal as a successful payment.
    let thrown: unknown;
    try {
      assertPortalMethodEnabled({ enabled: ["KNET"], method: "APPLE_PAY" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(Response);
  });
});

describe("createPayment enforces the admin's portal payment methods", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MYFATOORAH_API_KEY;
  });

  /** استدعاء يغطي إعدادات الشركة وهوية المتصل معًا. */
  const callWith = (opts: {
    applePay: boolean;
    googlePay: boolean;
    callerTenantId?: string | null;
    paymentMethod: string;
  }) => {
    const rpc = vi.fn().mockImplementation((rpcName: string) => {
      if (rpcName === "evaluate_portal_payable_invoices") {
        return { data: [{ invoice_id: "inv-1", balance: 50, is_selectable: true }], error: null };
      }
      // Staff authorization for the on-behalf path.
      if (rpcName === "has_permission") return { data: true, error: null };
      return { data: null, error: null };
    });
    const gFn = createPayment as any;
    // Not `??`: null is the meaningful value here — it is how a staff profile is
    // modelled — so it must survive rather than fall back to the tenant id.
    const callerTenantId = opts.callerTenantId === undefined ? "tenant-123" : opts.callerTenantId;
    gFn._context = {
      supabase: createMockSupabase(rpc, callerTenantId, {
        applePay: opts.applePay,
        googlePay: opts.googlePay,
      }),
      userId: "user-1",
    };
    return gFn({ invoiceIds: ["inv-1"], paymentMethod: opts.paymentMethod });
  };

  it("refuses a tenant asking for a method the admin switched off", async () => {
    await expect(
      callWith({ applePay: false, googlePay: false, paymentMethod: "GOOGLE_PAY" }),
    ).rejects.toThrow(/not available/i);
  });

  it("refuses before reserving a payment request, so no orphan row is left", async () => {
    // The reservation is the first supabaseAdmin write in the handler. If the
    // refusal ran after it, a request row would exist for a payment that can
    // never happen.
    const maybeSingle = vi.mocked((supabaseAdmin as any).maybeSingle);
    maybeSingle.mockClear();
    await expect(
      callWith({ applePay: false, googlePay: false, paymentMethod: "APPLE_PAY" }),
    ).rejects.toThrow(/not available/i);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("never refuses KNET, whatever the admin switched off", async () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: {
        status: "pending",
        payment_url: "https://myfatoorah.com/knet-link",
        created_at: FRESH_CREATED_AT,
        gateway_connection_id: "connection-123",
        credentials_version: 1,
        code: "PREQ-1",
        amount: 50,
        request_payload: { PaymentMethod: "KNET" },
      },
      error: null,
    });
    const result = await callWith({
      applePay: false,
      googlePay: false,
      paymentMethod: "KNET",
    });
    expect(result.paymentUrl).toBe("https://myfatoorah.com/knet-link");
  });

  it("exempts staff, whose KNET-link button pins a method of its own", async () => {
    // admin.invoices.tsx passes paymentMethod: "KNET" explicitly. The setting
    // governs what a tenant is offered, not what staff may issue, so a staff
    // caller must get through even when the portal has that rail switched off.
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    vi.mocked((supabaseAdmin as any).maybeSingle).mockResolvedValueOnce({
      data: {
        status: "pending",
        payment_url: "https://myfatoorah.com/googlepay-link",
        created_at: FRESH_CREATED_AT,
        gateway_connection_id: "connection-123",
        credentials_version: 1,
        code: "PREQ-2",
        amount: 50,
        request_payload: { PaymentMethod: "GOOGLE_PAY" },
      },
      error: null,
    });
    const result = await callWith({
      applePay: false,
      googlePay: false,
      callerTenantId: null,
      paymentMethod: "GOOGLE_PAY",
    });
    expect(result.paymentUrl).toBe("https://myfatoorah.com/googlepay-link");
  });
});
