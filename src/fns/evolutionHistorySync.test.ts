import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_CATALOG } from "@/jobs/catalog";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = (input?: { headers?: unknown }) =>
      fn._handler({ data: undefined, context: fn._context, headers: input?.headers });
    fn._context = {
      supabase: { rpc: async () => ({ data: true, error: null }) },
      userId: "admin-user",
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation(() => fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({
    server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

// The module now derives the dedupe day from the worker's company-moment
// helper, which builds the service-role client at import time; the tests never
// touch it, so the real client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const db = {
  connection: null as Record<string, unknown> | null,
  provider: {
    provider: "evolution_api",
    is_enabled: true,
    config: { api_base: "http://evolution:8080", api_key_env: "TEST_EVOLUTION_KEY" },
  } as Record<string, unknown>,
  contactUpserts: [] as Record<string, unknown>[][],
  ingestBatches: [] as Record<string, unknown>[][],
  /** message_id → chat_number rows the "live webhook" already ingested. */
  liveMessages: {} as Record<string, string>,
  /** طلبات المهام المسجَّلة عبر `enqueue_job`. */
  jobs: [] as { kind: string; payload: Record<string, unknown>; dedupeKey: string | null }[],
};

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
  function builder(table: string) {
    const chain: any = {
      _inIds: [] as string[],
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: (_column: string, ids: string[]) => {
        chain._inIds = ids;
        return chain;
      },
      limit: () => {
        if (table !== "whatsapp_messages") throw new Error(`Unexpected limit on ${table}`);
        const hit = chain._inIds
          .map((id: string) => db.liveMessages[id])
          .filter(Boolean)
          .map((chat_number: string) => ({ chat_number }));
        return Promise.resolve({ data: hit.slice(0, 1), error: null });
      },
      maybeSingle: () => {
        if (table === "evolution_connections")
          return Promise.resolve({ data: db.connection, error: null });
        if (table === "provider_configs")
          return Promise.resolve({ data: db.provider, error: null });
        throw new Error(`Unexpected maybeSingle on ${table}`);
      },
      upsert(rows: Record<string, unknown>[]) {
        db.contactUpserts.push(rows);
        return {
          select: () =>
            Promise.resolve({ data: rows.map((_, i) => ({ id: `c-${i}` })), error: null }),
        };
      },
    };
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "enqueue_job") {
        db.jobs.push({
          kind: String(args._kind),
          payload: (args._payload ?? {}) as Record<string, unknown>,
          dedupeKey: (args._dedupe_key as string | null) ?? null,
        });
        return Promise.resolve({ data: `job-${db.jobs.length}`, error: null });
      }
      const rows = (args.p_rows ?? []) as Record<string, unknown>[];
      db.ingestBatches.push(rows);
      return Promise.resolve({ data: rows.length, error: null });
    }),
  };
  return {
    companyClient: () => client,
  };
});

import { runEvolutionHistorySweep, runEvolutionHistorySync } from "./evolutionHistorySync";

/** Routes the stubbed fetch by Evolution endpoint path. */
function stubEvolution(handlers: {
  contacts?: unknown;
  chats?: unknown;
  messages?: (page: number, remoteJid: string) => unknown;
}) {
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    let payload: unknown = {};
    if (path.includes("/chat/findContacts/")) payload = handlers.contacts ?? [];
    else if (path.includes("/chat/findChats/")) payload = handlers.chats ?? [];
    else if (path.includes("/chat/findMessages/")) {
      const body = JSON.parse(String((init as RequestInit).body));
      payload = handlers.messages?.(body.page, body.where.key.remoteJid) ?? [];
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function baileysMessage(id: string, jid: string, body: string) {
  return {
    key: { id, remoteJid: jid, fromMe: false },
    pushName: "أحمد",
    messageTimestamp: 1756000000,
    message: { conversation: body },
  };
}

describe("runEvolutionHistorySweep", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_EVOLUTION_KEY", "evo-key");
    db.connection = { instance_name: "danat", last_connection_state: "open" };
    db.contactUpserts = [];
    db.ingestBatches = [];
    db.liveMessages = {};
    db.jobs = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses to sweep without an open session, naming the fix", async () => {
    db.connection = { instance_name: "danat", last_connection_state: "close" };
    await expect(
      runEvolutionHistorySweep({ companyId: TEST_COMPANY.id, connectionId: TEST_COMPANY.id }),
    ).rejects.toThrow(/scan the qr/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("imports contacts and walks chats, skipping groups and the system chat", async () => {
    stubEvolution({
      contacts: [
        { remoteJid: "96550123456@s.whatsapp.net", pushName: "أحمد" },
        { remoteJid: "12345@g.us", pushName: "Group" },
      ],
      chats: [
        { remoteJid: "96550123456@s.whatsapp.net" },
        { remoteJid: "12345@g.us" },
        { remoteJid: "0@s.whatsapp.net" },
      ],
      messages: () => [baileysMessage("h-1", "96550123456@s.whatsapp.net", "قديمة")],
    });

    const result = await runEvolutionHistorySweep({
      companyId: TEST_COMPANY.id,
      connectionId: TEST_COMPANY.id,
    });

    expect(result).toMatchObject({
      chatsWalked: 1,
      chatsSkipped: 2,
      chatsAwaitingLid: 0,
      messagesImported: 1,
      contactsImported: 1,
      complete: true,
    });
    // Group contacts never reach the contacts table.
    expect(db.contactUpserts[0]).toEqual([
      { phone: "96550123456", name: "أحمد", avatar_url: null },
    ]);
  });

  it("resolves a @lid chat through a message id the live webhook already holds", async () => {
    // Evolution stores history under bare @lid ids while live events are
    // phone-normalised — the shared message id is the only bridge between them.
    db.liveMessages["anchor-1"] = "96599131404";
    stubEvolution({
      chats: [{ remoteJid: "84885901418607@lid" }],
      messages: () => [
        baileysMessage("anchor-1", "84885901418607@lid", "حديثة"),
        baileysMessage("old-1", "84885901418607@lid", "قديمة جداً"),
      ],
    });

    const result = await runEvolutionHistorySweep({
      companyId: TEST_COMPANY.id,
      connectionId: TEST_COMPANY.id,
    });

    expect(result).toMatchObject({ chatsWalked: 1, chatsAwaitingLid: 0, messagesImported: 2 });
    const rows = db.ingestBatches[0];
    expect(rows.map((row) => row.chat_number)).toEqual(["96599131404", "96599131404"]);
    expect(rows.every((row) => row.count_unread === false)).toBe(true);
  });

  it("parks a @lid chat with no live anchor instead of importing under a fake number", async () => {
    stubEvolution({
      chats: [{ remoteJid: "84885901418607@lid" }],
      messages: () => [baileysMessage("h-lid", "84885901418607@lid", "معلّقة")],
    });

    const result = await runEvolutionHistorySweep({
      companyId: TEST_COMPANY.id,
      connectionId: TEST_COMPANY.id,
    });

    expect(result).toMatchObject({
      chatsWalked: 0,
      chatsAwaitingLid: 1,
      messagesImported: 0,
      complete: true,
    });
    expect(db.ingestBatches).toEqual([]);
  });

  it("marks history rows count_unread=false so imports never light the badge", async () => {
    stubEvolution({
      chats: [{ remoteJid: "96550123456@s.whatsapp.net" }],
      messages: () => [baileysMessage("h-2", "96550123456@s.whatsapp.net", "old")],
    });

    await runEvolutionHistorySweep({ companyId: TEST_COMPANY.id, connectionId: TEST_COMPANY.id });

    expect(db.ingestBatches[0][0]).toMatchObject({
      message_id: "h-2",
      chat_number: "96550123456",
      count_unread: false,
    });
  });

  it("follows the paged envelope to its `pages` terminator, not short pages", async () => {
    const seen: number[] = [];
    stubEvolution({
      chats: [{ remoteJid: "96550123456@s.whatsapp.net" }],
      messages: (page) => {
        seen.push(page);
        return {
          messages: {
            records: [baileysMessage(`p-${page}`, "96550123456@s.whatsapp.net", `msg ${page}`)],
            pages: 3,
          },
        };
      },
    });

    const result = await runEvolutionHistorySweep({
      companyId: TEST_COMPANY.id,
      connectionId: TEST_COMPANY.id,
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(result.messagesImported).toBe(3);
    expect(result.complete).toBe(true);
  });

  it("reports complete=false when the per-run chat ceiling truncates the sweep", async () => {
    const manyChats = Array.from({ length: 30 }, (_, i) => ({
      remoteJid: `96550${String(100000 + i)}@s.whatsapp.net`,
    }));
    stubEvolution({ chats: manyChats, messages: () => [] });

    const result = await runEvolutionHistorySweep({
      companyId: TEST_COMPANY.id,
      connectionId: TEST_COMPANY.id,
    });

    expect(result.chatsWalked).toBe(25);
    expect(result.complete).toBe(false);
  });
});

describe("runEvolutionHistorySync (the server function)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TEST_EVOLUTION_KEY", "evo-key");
    db.connection = { instance_name: "danat", last_connection_state: "open" };
    db.contactUpserts = [];
    db.ingestBatches = [];
    db.liveMessages = {};
    db.jobs = [];
  });

  it("enqueues exactly one catalogue-valid whatsapp.history.sync job and sweeps nothing here", async () => {
    const result = await runEvolutionHistorySync({});

    expect(result).toEqual({ queued: true, jobRequestId: "job-1" });
    expect(db.jobs).toHaveLength(1);
    expect(db.jobs[0].kind).toBe("whatsapp.history.sync");
    expect(db.jobs[0].payload).toEqual({ connectionId: TEST_COMPANY.id });
    expect(() =>
      JOB_CATALOG["whatsapp.history.sync"].payload.parse(db.jobs[0].payload),
    ).not.toThrow();
    // Dedupe connection id + day (contracts/jobs.md section 5).
    expect(db.jobs[0].dedupeKey).toMatch(
      new RegExp(`^whatsapp\\.history\\.sync:${TEST_COMPANY.id}:\\d{4}-\\d{2}-\\d{2}$`),
    );
    // No slow work here: the provider is never contacted and nothing is
    // imported — the worker's sweep does that.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.ingestBatches).toEqual([]);
    expect(db.contactUpserts).toEqual([]);
  });

  it("refuses the click when the session is closed, before anything is queued", async () => {
    db.connection = { instance_name: "danat", last_connection_state: "close" };

    await expect(runEvolutionHistorySync({})).rejects.toThrow(/scan the qr/i);

    expect(db.jobs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
