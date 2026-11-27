import { describe, expect, it, vi } from "vitest";

import { isCompanyContextError } from "@/company/errors";

// Mock createServerFn before importing the module under test.
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

const boundary = vi.hoisted(() => ({
  company: {
    id: "company-123",
    slug: "frozen",
    status: "suspended" as const,
    host: "frozen.ijary.app",
  },
  loadActiveGatewayConnection: vi.fn(),
  createGateway: vi.fn(),
  companyClient: vi.fn(),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => boundary.company,
  getRequestCompany: () => boundary.company,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: boundary.companyClient,
}));

vi.mock("@/gateways/connectionStore.server", () => ({
  loadActiveGatewayConnection: boundary.loadActiveGatewayConnection,
}));

vi.mock("@/gateways/registry", () => ({
  gatewayRegistry: { create: boundary.createGateway },
}));

import { createPayment } from "./createPayment";

/** شكل دالة الخادم كما يقودها الاختبار: سياق يُمرَّر مع كل نداء. */
interface PaymentServerFn {
  _context: { supabase: unknown; userId: string };
  (data: unknown): Promise<unknown>;
}

const pay = createPayment as unknown as PaymentServerFn;

describe("createPayment on a suspended company (T121)", () => {
  it("refuses with the COMPANY_SUSPENDED code", async () => {
    const supabase = { from: vi.fn(), rpc: vi.fn() };
    pay._context = { supabase, userId: "user-1" };

    const error = await pay({ invoiceIds: ["inv-1"] }).catch((thrown: unknown) => thrown);

    expect(isCompanyContextError(error, "COMPANY_SUSPENDED")).toBe(true);
  });

  it("refuses before the gateway is contacted", async () => {
    const supabase = { from: vi.fn(), rpc: vi.fn() };
    pay._context = { supabase, userId: "user-1" };

    await expect(pay({ invoiceIds: ["inv-1"] })).rejects.toThrow(/suspended/i);

    expect(boundary.loadActiveGatewayConnection).not.toHaveBeenCalled();
    expect(boundary.createGateway).not.toHaveBeenCalled();
  });

  it("reads no invoice and writes no payment request for a paused account", async () => {
    // A request row minted for a payment that can never happen is an orphan the
    // operator has to clean up by hand.
    const supabase = { from: vi.fn(), rpc: vi.fn() };
    pay._context = { supabase, userId: "user-1" };

    await pay({ invoiceIds: ["inv-1"] }).catch(() => undefined);

    expect(boundary.companyClient).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
