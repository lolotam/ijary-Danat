import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockReturnValue({
    middleware: vi.fn().mockReturnThis(),
    validator: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
  }),
  createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const db = {
  /** whatsapp_chats rows the fake PostgREST answers `in()` selects with. */
  chats: [] as { chat_number: string; avatar_url: string | null }[],
  /** whatsapp_contacts rows, keyed by `phone` the way the real table is. */
  contacts: [] as { phone: string; avatar_url: string | null }[],
  connection: { instance_name: "danat", last_connection_state: "open" } as Record<
    string,
    unknown
  > | null,
  updates: [] as { table: string; values: Record<string, unknown>; filter: string }[],
};

vi.mock("@/integrations/supabase/client.server", () => {
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
    Object.assign(chain, {
      select: () => chain,
      eq: (_column: string, value: string) => {
        filter = value;
        return chain;
      },
      in: () =>
        Promise.resolve({
          data: table === "whatsapp_contacts" ? db.contacts : db.chats,
          error: null,
        }),
      maybeSingle: () => Promise.resolve({ data: db.connection, error: null }),
      update(next: Record<string, unknown>) {
        values = next;
        return chain;
      },
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (values) db.updates.push({ table, values, filter });
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    });
    return chain;
  }
  return { supabaseAdmin: { from: (table: string) => builder(table) } };
});

vi.mock("@/fns/evolutionSession", () => ({
  loadEvolutionProviderConfig: vi.fn().mockResolvedValue({ config: {} }),
}));

const fetchProfilePictureUrl = vi.fn();
vi.mock("@/lib/providers/evolution", () => ({
  evolutionClientFromConfig: () => ({ fetchProfilePictureUrl }),
}));

const { backfillChatAvatars } = await import("./evolutionAvatars");

beforeEach(() => {
  db.chats = [];
  db.contacts = [];
  db.connection = { instance_name: "danat", last_connection_state: "open" };
  db.updates = [];
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
    db.connection = { instance_name: "danat", last_connection_state: "close" };

    await backfillChatAvatars(["96551234567"]);

    expect(fetchProfilePictureUrl).not.toHaveBeenCalled();
  });
});
