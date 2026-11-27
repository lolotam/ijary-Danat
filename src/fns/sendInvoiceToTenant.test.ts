import { beforeEach, describe, expect, test, vi } from "vitest";

// The repo's established shape for exercising a createServerFn handler
// directly — see applyAllocation.test.ts.
vi.mock("@tanstack/react-start", () => {
  const fn: {
    (input: { data: unknown; context: unknown }): unknown;
    _handler?: (args: { data: unknown; context: unknown }) => unknown;
    middleware: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn>;
  } = ((args: { data: unknown; context: unknown }) => fn._handler?.(args)) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
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

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";

const invoiceRow = vi.fn();
const rpc = vi.fn();

// The stub answers only the tables the request may read. Anything else throws,
// so a send that reached the database would fail the test instead of passing it.
const dbClient = {
  from: (table: string) => {
    if (table === "invoices") return { select: () => ({ eq: () => ({ single: invoiceRow }) }) };
    throw new Error(`Unexpected table in test: ${table}`);
  },
  rpc: (...args: unknown[]) => rpc(...args),
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const { sendInvoiceToTenant } = await import("./sendInvoiceToTenant");

const context = {
  userId: "user-1",
  supabase: { rpc: async () => ({ data: true, error: null }) },
};

const send = (channels: ("email" | "whatsapp")[]) =>
  (sendInvoiceToTenant as unknown as (a: { data: unknown; context: unknown }) => Promise<unknown>)({
    data: { invoiceId: INVOICE_ID, channels },
    context,
  });

beforeEach(() => {
  vi.clearAllMocks();
  invoiceRow.mockResolvedValue({ data: { id: INVOICE_ID }, error: null });
  rpc.mockResolvedValue({ data: "job-1", error: null });
});

describe("sendInvoiceToTenant queues the document instead of sending it", () => {
  test.each(["email", "whatsapp"] as const)(
    "queues one %s job whose payload matches the catalogue",
    async (channel) => {
      const result = (await send([channel])) as { queued: boolean; jobRequestIds: string[] };

      // One row in the outbox. The payload reached it only because it passed
      // the catalogue's schema: `enqueueJob` parses it before the insert.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("enqueue_job", {
        _kind: "invoice.send",
        _payload: { invoiceId: INVOICE_ID, channel },
        _dedupe_key: null,
        _requested_by: null,
      });
      expect(result).toEqual({ queued: true, jobRequestIds: ["job-1"] });
    },
  );

  test("queues one job per channel, so both legs are covered", async () => {
    await send(["email", "whatsapp"]);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(
      rpc.mock.calls.map(
        ([, args]) => (args as { _payload: { channel: string } })._payload.channel,
      ),
    ).toEqual(["email", "whatsapp"]);
  });

  test("carries no dedupe key, so an admin may resend the same invoice", async () => {
    await send(["email"]);

    const args = rpc.mock.calls[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBeNull();
  });

  test("refuses an invoice that is not this company's", async () => {
    invoiceRow.mockResolvedValue({ data: null, error: { message: "Invoice not found" } });

    await expect(send(["email"])).rejects.toThrow("Invoice not found");
    expect(rpc).not.toHaveBeenCalled();
  });
});
