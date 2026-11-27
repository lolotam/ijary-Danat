import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_CATALOG } from "@/jobs/catalog";

vi.mock("@tanstack/react-start", () => {
  // A FRESH object per createServerFn() call, so the avatar sweep's function
  // and the enqueuing server function never share one `_handler`.
  function makeFn() {
    const fn: any = (data?: unknown) => fn._handler({ data, context: fn._context });
    fn._context = {
      userId: "admin-user",
      supabase: { rpc: async () => ({ data: true, error: null }) },
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((h: any) => {
      fn._handler = h;
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
    createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
  };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

// The module now derives the dedupe day from the worker's company-moment
// helper, which builds the service-role client at import time; the tests never
// touch it, so the real client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

/** معرّف اتصال واتساب النشط للشركة في بيانات الاختبار. */
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

const db = {
  /** whatsapp_chats rows the fake PostgREST answers `in()` selects with. */
  chats: [] as { chat_number: string; avatar_url: string | null }[],
  /** whatsapp_contacts rows, keyed by `phone` the way the real table is. */
  contacts: [] as { phone: string; avatar_url: string | null }[],
  /** the company's active `evolution_qr` connection row (null = never paired). */
  connection: {
    id: CONNECTION_ID,
    company_id: "00000000-0000-4000-8000-000000000001",
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: "danat",
  } as Record<string, unknown> | null,
  updates: [] as { table: string; values: Record<string, unknown>; filter: string }[],
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
  /**
   * بديل مبسّط لسلسلة استعلامات PostgREST يسجّل التحديثات ويعيد صفوف الاختبار.
   *
   * The database is a system boundary, so it is mocked here rather than
   * carried in; the assertions are about which table was written and with
   * what, which is what the real client would send.
   */
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    let values: Record<string, unknown> | null = null;
    let filter = "";
    const filters: Array<[string, unknown]> = [];
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        filter = String(value);
        return chain;
      },
      in: () =>
        Promise.resolve({
          data: table === "whatsapp_contacts" ? db.contacts : db.chats,
          error: null,
        }),
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "whatsapp_connections" && db.connection
              ? filters.every(([column, value]) => db.connection?.[column] === value)
                ? db.connection
                : null
              : null,
          error: null,
        }),
      update(next: Record<string, unknown>) {
        values = next;
        return chain;
      },
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (values) {
          db.updates.push({ table, values, filter });
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        const rows =
          table === "whatsapp_chats" ? db.chats : table === "whatsapp_contacts" ? db.contacts : [];
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    });
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "enqueue_job") {
        db.jobs.push({
          kind: String(args._kind),
          payload: (args._payload ?? {}) as Record<string, unknown>,
          dedupeKey: (args._dedupe_key as string | null) ?? null,
        });
        return { data: `job-${db.jobs.length}`, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { companyClient: () => client };
});

vi.mock("@/fns/evolutionSession", async (importOriginal) => ({
  // Partial: the connection reader is the real one, so the query's own company
  // and method filters are what the test observes.
  ...(await importOriginal<Record<string, unknown>>()),
  loadEvolutionProviderConfig: vi.fn().mockResolvedValue({ config: {} }),
}));

const fetchProfilePictureUrl = vi.fn();
vi.mock("@/lib/providers/evolution", () => ({
  evolutionClientFromConfig: () => ({ fetchProfilePictureUrl }),
}));

const { backfillChatAvatars, runEvolutionAvatarSweep, syncEvolutionAvatars } =
  await import("./evolutionAvatars");

beforeEach(() => {
  db.chats = [];
  db.contacts = [];
  db.connection = {
    id: "33333333-3333-4333-8333-333333333333",
    company_id: TEST_COMPANY.id,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: "danat",
  };
  db.updates = [];
  db.jobs = [];
  fetchProfilePictureUrl.mockReset();
});

describe("backfillChatAvatars", () => {
  it("stores the picture on both the chat and the contact", async () => {
    db.chats = [{ chat_number: "96551234567", avatar_url: null }];
    db.contacts = [{ phone: "96551234567", avatar_url: null }];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: "https://pps/x.jpg" });

    await backfillChatAvatars(["96551234567"]);

    expect(db.updates).toEqual([
      {
        table: "whatsapp_chats",
        values: { avatar_url: "https://pps/x.jpg" },
        filter: "96551234567",
      },
      {
        table: "whatsapp_contacts",
        values: { avatar_url: "https://pps/x.jpg" },
        filter: "96551234567",
      },
    ]);
  });

  it("asks the gateway nothing when both tables already have the picture", async () => {
    // Every message after the first in a chat lands here; a round trip per
    // message would put the gateway on the delivery path for no gain.
    db.chats = [{ chat_number: "96551234567", avatar_url: "https://pps/old.jpg" }];
    db.contacts = [{ phone: "96551234567", avatar_url: "https://pps/old.jpg" }];

    await backfillChatAvatars(["96551234567"]);

    expect(fetchProfilePictureUrl).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it("copies the chat's picture to a contact that has none, without a gateway call", async () => {
    // History sync fills the two tables from different Evolution endpoints, so
    // this gap is routine — and the chat row alone used to make the number look
    // complete, leaving the contacts table on initials indefinitely.
    db.chats = [{ chat_number: "96551234567", avatar_url: "https://pps/live.jpg" }];
    db.contacts = [{ phone: "96551234567", avatar_url: null }];

    await backfillChatAvatars(["96551234567"]);

    expect(fetchProfilePictureUrl).not.toHaveBeenCalled();
    expect(db.updates.map((u) => [u.table, u.values.avatar_url])).toEqual([
      ["whatsapp_chats", "https://pps/live.jpg"],
      ["whatsapp_contacts", "https://pps/live.jpg"],
    ]);
  });

  it("treats an expired stored link as no picture at all", async () => {
    // oe= in the past: the CDN answers 403, so the row "has" a picture that
    // renders as initials. The next message is the cheapest moment to replace it.
    db.chats = [{ chat_number: "96551234567", avatar_url: "https://pps/x.jpg?oe=5AA89C26" }];
    db.contacts = [{ phone: "96551234567", avatar_url: "https://pps/x.jpg?oe=5AA89C26" }];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: "https://pps/fresh.jpg" });

    await backfillChatAvatars(["96551234567"]);

    expect(fetchProfilePictureUrl).toHaveBeenCalledTimes(1);
    expect(db.updates.map((u) => u.values.avatar_url)).toEqual([
      "https://pps/fresh.jpg",
      "https://pps/fresh.jpg",
    ]);
  });

  it("clears both tables when the contact has taken their picture down", async () => {
    // A successful "no picture" answer is the only signal we get that a face
    // was removed; leaving the old URL in place keeps showing it until a CDN
    // expiry that some URLs never carry.
    db.chats = [{ chat_number: "96551234567", avatar_url: null }];
    db.contacts = [{ phone: "96551234567", avatar_url: null }];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: null });

    await backfillChatAvatars(["96551234567"]);

    expect(db.updates).toEqual([
      { table: "whatsapp_chats", values: { avatar_url: null }, filter: "96551234567" },
      { table: "whatsapp_contacts", values: { avatar_url: null }, filter: "96551234567" },
    ]);
  });

  it("swallows a gateway failure — the message was already sent", async () => {
    db.chats = [{ chat_number: "96551234567", avatar_url: null }];
    db.contacts = [{ phone: "96551234567", avatar_url: null }];
    fetchProfilePictureUrl.mockRejectedValue(new Error("Evolution API request timed out"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(backfillChatAvatars(["96551234567"])).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("does nothing while the WhatsApp session is closed", async () => {
    db.chats = [{ chat_number: "96551234567", avatar_url: null }];
    db.contacts = [{ phone: "96551234567", avatar_url: null }];
    db.connection = { ...db.connection, status: "disconnected" } as Record<string, unknown>;

    await backfillChatAvatars(["96551234567"]);

    expect(fetchProfilePictureUrl).not.toHaveBeenCalled();
  });
});

describe("runEvolutionAvatarSweep", () => {
  it("walks the numbers and stores their pictures", async () => {
    db.chats = [
      { chat_number: "96551234561", avatar_url: null },
      { chat_number: "96551234562", avatar_url: null },
    ];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: "https://pps/x.jpg" });

    const result = await runEvolutionAvatarSweep({
      companyId: TEST_COMPANY.id,
      connectionId: CONNECTION_ID,
      after: null,
    });

    expect(result).toMatchObject({ checked: 2, updated: 2, complete: true, nextCursor: null });
    expect(db.updates.filter((entry) => entry.table === "whatsapp_chats")).toHaveLength(2);
  });

  it("resumes past the cursor instead of re-checking the head of the directory", async () => {
    db.chats = [
      { chat_number: "96551234561", avatar_url: null },
      { chat_number: "96551234562", avatar_url: null },
    ];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: "https://pps/x.jpg" });

    const result = await runEvolutionAvatarSweep({
      companyId: TEST_COMPANY.id,
      connectionId: CONNECTION_ID,
      after: "96551234561",
    });

    expect(result.checked).toBe(1);
    expect(fetchProfilePictureUrl).toHaveBeenCalledTimes(1);
    expect(fetchProfilePictureUrl).toHaveBeenCalledWith("danat", "96551234562");
  });
});

describe("syncEvolutionAvatars (the server function)", () => {
  it("enqueues exactly one catalogue-valid whatsapp.avatars.sync job and sweeps nothing here", async () => {
    db.chats = [{ chat_number: "96551234567", avatar_url: null }];
    fetchProfilePictureUrl.mockResolvedValue({ profilePictureUrl: "https://pps/x.jpg" });

    const result = await syncEvolutionAvatars({});

    expect(result).toEqual({ queued: true, jobRequestId: "job-1" });
    expect(db.jobs).toHaveLength(1);
    expect(db.jobs[0].kind).toBe("whatsapp.avatars.sync");
    // The payload carries the connection id, so the worker walks THIS
    // company's link and not the company id it used to carry.
    expect(db.jobs[0].payload).toEqual({ connectionId: CONNECTION_ID });
    expect(() =>
      JOB_CATALOG["whatsapp.avatars.sync"].payload.parse(db.jobs[0].payload),
    ).not.toThrow();
    // Dedupe connection id + day (contracts/jobs.md section 5).
    expect(db.jobs[0].dedupeKey).toMatch(
      new RegExp(`^whatsapp\\.avatars\\.sync:${CONNECTION_ID}:\\d{4}-\\d{2}-\\d{2}$`),
    );
    // No slow work here: the gateway is never asked for a picture.
    expect(fetchProfilePictureUrl).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it("refuses the click when the session is closed, before anything is queued", async () => {
    db.connection = { ...db.connection, status: "disconnected" } as Record<string, unknown>;

    await expect(syncEvolutionAvatars({})).rejects.toThrow(/scan the qr/i);

    expect(db.jobs).toEqual([]);
  });
});
