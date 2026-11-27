import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSyncFake,
  seedEvolution,
  seedSyncTable,
  syncCompanyClientModule,
  syncRequestCompanyModule,
  type SyncFake,
} from "./sync.testkit";

// The handlers reach Postgres through the company client and the service-role
// client only through the scheduler's own module (the company-moment helper);
// the tests drive the client through the fake, so the real service-role client
// must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/company/requestCompany.server", () => syncRequestCompanyModule());
vi.mock("@/company/companyClient.server", () => syncCompanyClientModule(fake));

const fake: SyncFake = createSyncFake();
const { createWhatsappAvatarsSyncHandler, createWhatsappHistorySyncHandler } =
  await import("./syncWhatsapp");

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
// The job payload carries the WhatsApp connection id (migration 333), not the
// company id the legacy singleton used to travel with.
const CONNECTION_A = "44444444-4444-4444-8444-444444444444";
const CONNECTION_B = "55555555-5555-4555-8555-555555555555";

/** يوجّه استدعاءات fetch المُقلَّدة بحسب نهاية نقطة Evolution. */
function stubEvolution(handlers: {
  contacts?: unknown;
  chats?: unknown;
  messages?: unknown;
  profilePicture?: unknown;
}) {
  vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    let payload: unknown = {};
    if (path.includes("/chat/findContacts/")) payload = handlers.contacts ?? [];
    else if (path.includes("/chat/findChats/")) payload = handlers.chats ?? [];
    else if (path.includes("/chat/findMessages/")) {
      payload = handlers.messages ?? [];
    } else if (path.includes("fetchProfilePictureUrl")) {
      payload = handlers.profilePicture ?? { profilePictureUrl: null };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

/** رسالة بأشكال بايلييس كما يعيدها مخزن Evolution. */
function baileysMessage(id: string, jid: string, body: string) {
  return {
    key: { id, remoteJid: jid, fromMe: false },
    pushName: "أحمد",
    messageTimestamp: 1756000000,
    message: { conversation: body },
  };
}

beforeEach(() => {
  fake.tables.clear();
  fake.objects.clear();
  fake.rpcs.length = 0;
  fake.jobs.length = 0;
  fake.restoreCalls.length = 0;
  fake.holdsAdminRole = true;
  fake.ingested.clear();
  seedSyncTable(fake, "cron_jobs", []);
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("EVOLUTION_API_KEY", "evo-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the whatsapp.history.sync handler", () => {
  function runHistory(companyId = COMPANY_A, connectionId = CONNECTION_A) {
    return createWhatsappHistorySyncHandler()({
      jobRequestId: JOB_ID,
      companyId,
      payload: { connectionId },
      attempt: 1,
    }) as Promise<{ messagesImported: number; complete: boolean }>;
  }

  it("imports the history once, and a second run of the same job imports nothing twice", async () => {
    seedEvolution(fake, COMPANY_A, CONNECTION_A);
    const jid = "96550123456@s.whatsapp.net";
    stubEvolution({
      contacts: [{ remoteJid: jid, pushName: "أحمد" }],
      chats: [{ remoteJid: jid }],
      messages: [baileysMessage("m-1", jid, "مرحبا")],
    });

    const first = await runHistory();
    expect(first.messagesImported).toBe(1);

    const second = await runHistory();
    // The ingest RPC upserts on message_id, so the retry's sweep finds every
    // message already stored — same state, no second record.
    expect(second.messagesImported).toBe(0);
    expect(fake.ingested.size).toBe(1);
  });

  it("finds nothing in a connection that belongs to another company", async () => {
    seedEvolution(fake, COMPANY_B, CONNECTION_B);

    await expect(runHistory(COMPANY_A, CONNECTION_B)).rejects.toThrow(/open WhatsApp session/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("the whatsapp.avatars.sync handler", () => {
  function runAvatars(companyId = COMPANY_A, connectionId = CONNECTION_A) {
    return createWhatsappAvatarsSyncHandler()({
      jobRequestId: JOB_ID,
      companyId,
      payload: { connectionId },
      attempt: 1,
    }) as Promise<{ checked: number; updated: number; complete: boolean }>;
  }

  it("walks the whole directory in one job, pass by pass", async () => {
    // The job replaces the dialog's click-by-click cursor: a directory larger
    // than one pass's ceiling is still finished by a single job, because the
    // handler feeds each pass's cursor into the next.
    seedEvolution(fake, COMPANY_A, CONNECTION_A);
    const rows = Array.from({ length: 61 }, (_, index) => ({
      company_id: COMPANY_A,
      chat_number: `9655000${String(index).padStart(4, "0")}`,
    }));
    seedSyncTable(fake, "whatsapp_chats", rows);
    seedSyncTable(fake, "whatsapp_contacts", []);
    stubEvolution({ profilePicture: { profilePictureUrl: "http://pic/1.png" } });

    const result = await runAvatars();

    expect(result.complete).toBe(true);
    expect(result.checked).toBe(61);
    expect(result.updated).toBe(61);
  });

  it("a second run of the same jobRequestId stores the same state and creates no rows", async () => {
    seedEvolution(fake, COMPANY_A, CONNECTION_A);
    seedSyncTable(fake, "whatsapp_chats", [
      { company_id: COMPANY_A, chat_number: "965500000001", avatar_url: null },
    ]);
    seedSyncTable(fake, "whatsapp_contacts", [
      { company_id: COMPANY_A, phone: "965500000001", avatar_url: null },
    ]);
    stubEvolution({ profilePicture: { profilePictureUrl: "http://pic/1.png" } });

    await runAvatars();
    const afterFirst = structuredClone(fake.tables.get("whatsapp_chats"));
    await runAvatars();

    // Avatar writes are upserts of the same values: a rerun produces the same
    // state and no second record (contracts/jobs.md section 3).
    expect(fake.tables.get("whatsapp_chats")).toEqual(afterFirst);
    expect(fake.tables.get("whatsapp_chats")).toHaveLength(1);
    expect(fake.tables.get("whatsapp_contacts")).toHaveLength(1);
  });

  it("finds nothing in a connection that belongs to another company", async () => {
    seedEvolution(fake, COMPANY_B, CONNECTION_B);
    seedSyncTable(fake, "whatsapp_chats", []);
    seedSyncTable(fake, "whatsapp_contacts", []);

    await expect(runAvatars(COMPANY_A, CONNECTION_B)).rejects.toThrow(/open WhatsApp session/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
