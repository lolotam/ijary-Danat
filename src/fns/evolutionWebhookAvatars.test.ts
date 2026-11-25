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

const SECRET = "current-secret";

vi.mock("@/integrations/supabase/client.server", () => {
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
      // whatsapp_chats lookup inside the backfill: no row yet, so the number
      // counts as pictureless and a gateway lookup is attempted.
      in: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === "evolution_connections"
              ? {
                  instance_name: "danat",
                  webhook_secret: SECRET,
                  previous_webhook_secret: null,
                  last_connection_state: "open",
                }
              : null,
          error: null,
        }),
      update: () => chain,
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled),
    });
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
      rpc: () => Promise.resolve({ data: 1, error: null }),
    },
  };
});

vi.mock("@/fns/evolutionSession", async (importOriginal) => ({
  // Partial: the webhook reads the header name from this module too, and a
  // bare mock would 401 the request before it ever reached the ingest.
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
      new Request("https://danat-future.com/api/public/evolution-webhook", {
        method: "POST",
        headers: { "x-danat-webhook-secret": SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "messages.upsert",
          instance: "danat",
          data: [
            {
              key: { id: "m1", remoteJid: "96550000000@s.whatsapp.net" },
              message: { conversation: "مرحبا" },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    // And the lookup really was dispatched — the response beat it rather than
    // the backfill having been skipped altogether.
    await expect(lookupHappened).resolves.toBeUndefined();
  });
});
