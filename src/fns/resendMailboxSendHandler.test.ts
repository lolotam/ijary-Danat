import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const fn: {
    (input: { context: unknown; data: unknown }): unknown;
    _handler?: (args: { context: unknown; data: unknown }) => unknown;
    handler: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    middleware: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
  } = ((args: { context: unknown; data: unknown }) => fn._handler?.(args)) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  // `gmailSend` is pulled in transitively (for `plainTextFrom`) and builds
  // itself with `.inputValidator`, so the double needs both spellings.
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

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const sendWithResend = vi.fn();
vi.mock("@/lib/providers/resend", () => ({
  sendWithResend: (...args: unknown[]) => sendWithResend(...args),
}));

/**
 * عميل Supabase وهمي يردّ حسب الجدول المطلوب.
 *
 * Only the boundary is faked. The approved-sender list, the provider config and
 * the archival insert are all real queries in production, so each is answered
 * here by table name rather than by stubbing the functions that read them —
 * stubbing those would test nothing but the stubs.
 */
const state = {
  insertFails: false,
  providerEnabled: true,
  senderValues: ["ceo@danat-future.com"],
};

const insertedRows: Array<Record<string, unknown>> = [];

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => {
  function from(table: string) {
    const api: Record<string, unknown> = {
      eq: () => api,
      limit: () => api,
      order: () => api,
      maybeSingle: async () => resolve(table),
      select: () => api,
      single: async () => resolve(table),
      upsert: async (row: Record<string, unknown>) => {
        if (state.insertFails) return { error: { message: "database unavailable" } };
        insertedRows.push(row);
        return { error: null };
      },
      then: (onOk: (value: unknown) => unknown) => Promise.resolve(resolve(table)).then(onOk),
    };
    return api;
  }

  function resolve(table: string) {
    if (table === "option_lists") return { data: { id: "list-1" }, error: null };
    if (table === "option_list_items") {
      return { data: state.senderValues.map((value) => ({ value })), error: null };
    }
    if (table === "provider_configs") {
      return {
        data: { config: { secret_env: "TEST_KEY" }, is_enabled: state.providerEnabled },
        error: null,
      };
    }
    if (table === "companies") return { data: { id: "company-1" }, error: null };
    return { data: null, error: null };
  }

  return {
    companyClient: () => ({ from }),
    serverCompanyClient: (explicitCompanyId?: string) => ({
      companyId: explicitCompanyId ?? TEST_COMPANY.id,
      client: { from },
    }),
  };
});

const { resendMailboxSend } = await import("./resendMailboxSend");

/**
 * يستدعي المعالج مباشرة مع السياق الذي تحقنه الوسيطة.
 *
 * The public fetcher type describes what a *browser* may pass, and that
 * deliberately excludes `context` — the middleware supplies it server-side. The
 * handler under test is the server half, so the cast is narrowing the call to
 * what actually happens in production rather than papering over a mismatch.
 */
const invoke = resendMailboxSend as unknown as (args: {
  context: unknown;
  data: unknown;
}) => Promise<{ id: string }>;

/** يبني سياق طلب بصلاحية إرسال أو بدونها. */
function contextWith(allowed: boolean) {
  return {
    userId: "user-1",
    supabase: { rpc: vi.fn().mockResolvedValue({ data: allowed, error: null }) },
  };
}

const DATA = {
  attachments: [],
  bcc: [],
  body: "Body",
  cc: [],
  from: "ceo@danat-future.com",
  html: "<p>Body</p>",
  subject: "Notice",
  to: ["tenant@example.com"],
};

describe("resendMailboxSend handler", () => {
  beforeEach(() => {
    sendWithResend.mockReset();
    sendWithResend.mockResolvedValue({ messageId: "resend-1" });
    insertedRows.length = 0;
    state.insertFails = false;
    state.providerEnabled = true;
    state.senderValues = ["ceo@danat-future.com"];
  });

  it("refuses a caller without notifications.send and never reaches Resend", async () => {
    // The hole this closes: everything below the gate runs with the service
    // role, so any authenticated account — a tenant with a portal login
    // included — could otherwise send mail as ceo@danat-future.com.
    await expect(invoke({ context: contextWith(false), data: DATA })).rejects.toThrow(
      /permission/i,
    );

    expect(sendWithResend).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it("refuses a sender that is not in the approved catalogue", async () => {
    // A dropdown restricts the honest caller; the request body restricts nobody.
    await expect(
      invoke({
        context: contextWith(true),
        data: { ...DATA, from: "attacker@evil.example" },
      }),
    ).rejects.toThrow(/not an approved/i);

    expect(sendWithResend).not.toHaveBeenCalled();
  });

  it("refuses to send while the provider is disabled", async () => {
    state.providerEnabled = false;

    await expect(invoke({ context: contextWith(true), data: DATA })).rejects.toThrow(
      /not enabled/i,
    );

    expect(sendWithResend).not.toHaveBeenCalled();
  });

  it("sends and files the message as sent, through Resend", async () => {
    const result = await invoke({ context: contextWith(true), data: DATA });

    expect(result).toEqual({ id: "resend-1" });
    expect(sendWithResend).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      // `direction` explicit, never defaulted: the column is nullable and the
      // list renders null as *received*, so omitting it would invent an inbound
      // Resend message when no inbound path exists.
      direction: "sent",
      provider: "resend",
      message_id: "resend:resend-1",
      from_address: "ceo@danat-future.com",
    });
  });

  it("still reports success when the local archive write fails", async () => {
    // The mail has already left. Rejecting here would show an error, and the
    // obvious retry would deliver the message a second time.
    state.insertFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await invoke({ context: contextWith(true), data: DATA });

    expect(result).toEqual({ id: "resend-1" });
    // Logged rather than swallowed: the row is recoverable, a duplicate is not.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
