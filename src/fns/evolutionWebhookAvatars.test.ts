import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook must answer Evolution before the avatar lookup finishes.
 *
 * Regression guard for the review of PR #198: the first version awaited
 * `backfillChatAvatars` inside the ingest handler, so a gateway that had gone
 * slow held the HTTP 200 for up to five sequential 10s timeouts — and a
 * webhook Evolution considers slow is a webhook Evolution retries.
 *
 * Nothing here mocks the avatar module itself: that would only prove the mock
 * is not awaited. The gateway call underneath it is what never resolves, so
 * the response can only arrive if the handler truly does not wait for it.
 */

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockReturnValue({
    middleware: vi.fn().mockReturnThis(),
    validator: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
  }),
  createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

// The webhook secret is decrypted for real, so the test needs a master key and
// the same encrypt/bytea helpers the pairing path uses.
process.env.INTEGRATIONS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

import { encodeByteaHex } from "@/gateways/connectionStore.server";
import { encryptSecret } from "@/lib/secrets.server";

const SECRET = "current-secret";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_NAME = "ijary-00000000000040008000000000000001";

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

/** يبني صفّ سرّ مشفّر كما تكتبه دالة الاقتران. */
function secretRow(plain: string, version: number): Record<string, unknown> {
  const encrypted = encryptSecret(plain);
  return {
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
    version,
  };
}

// The owner lookup is the platform's read across companies (a database
// boundary); the stub answers with the fixture connection.
vi.mock("@/platform/whatsappConnectionLookup.server", () => ({
  lookupWhatsappConnectionById: async (connectionId: string) => ({
    id: connectionId,
    company_id: TEST_COMPANY.id,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: INSTANCE_NAME,
    phone_number_id: null,
  }),
}));

vi.mock("@/company/companyClient.server", () => {
  /**
   * بديل مبسّط لعميل Supabase: جلسة مفتوحة، ولا صورة مخزّنة لأي رقم.
   *
   * Shaped so the ingest reaches the avatar lookup — a stored picture would
   * skip it, and the test would pass without proving anything.
   */
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      // whatsapp_chats lookup inside the backfill: no row yet, so the number
      // counts as pictureless and a gateway lookup is attempted.
      in: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "whatsapp_connections"
              ? {
                  instance_name: "danat",
                  status: "connected",
                }
              : null,
          error: null,
        }),
      update: () => chain,
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (table === "company_secrets") {
          return Promise.resolve({ data: [secretRow(SECRET, 1)], error: null }).then(onFulfilled);
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    });
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string) => {
      return Promise.resolve({ data: 1, error: null });
    },
  };
  return {
    companyClient: () => client,
  };
});

vi.mock("@/fns/evolutionSession", async (importOriginal) => ({
  // Partial: only the provider config is stubbed; the connection reader stays
  // real so the ingest path runs as it does in production.
  ...(await importOriginal<Record<string, unknown>>()),
  loadEvolutionProviderConfig: vi.fn().mockResolvedValue({ config: {} }),
}));

/** Resolves when the gateway has actually been asked for a picture. */
let lookupStarted: () => void;
const lookupHappened = new Promise<void>((resolve) => {
  lookupStarted = resolve;
});

vi.mock("@/lib/providers/evolution", () => ({
  evolutionClientFromConfig: () => ({
    // Never resolves — the stand-in for a gateway that has stopped answering.
    fetchProfilePictureUrl: () => {
      lookupStarted();
      return new Promise(() => {});
    },
  }),
}));

const { respondToEvolutionWebhook } = await import("./evolutionWebhook");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("inbound webhook with a hung avatar gateway", () => {
  it("returns 200 without waiting for the profile-picture lookup", async () => {
    const response = await respondToEvolutionWebhook(
      new Request(`https://danat.ijary.app/api/public/webhooks/evolution/${CONNECTION_ID}`, {
        method: "POST",
        headers: { "x-danat-webhook-secret": SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "messages.upsert",
          instance: INSTANCE_NAME,
          data: [
            {
              key: { id: "m1", remoteJid: "96550000000@s.whatsapp.net" },
              message: { conversation: "مرحبا" },
            },
          ],
        }),
      }),
      CONNECTION_ID,
    );

    expect(response.status).toBe(200);
    // And the lookup really was dispatched — the response beat it rather than
    // the backfill having been skipped altogether.
    await expect(lookupHappened).resolves.toBeUndefined();
  });
});
