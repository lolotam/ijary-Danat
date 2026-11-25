import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));

import { LOGIN_AUDIT_ACTION, recordLoginAttempt } from "./loginAudit";

/** يبني طلباً وهمياً بترويسات الزائر المطلوبة في كل اختبار. */
function stubRequest(headers: Record<string, string>) {
  return new Request("https://danat-future.com/_serverFn/signInWithIdentifier", {
    method: "POST",
    headers,
  });
}

/** خيارات آخر عميل أُنشئ، وهي موضع الترويسات المُعاد إرسالها. */
function lastClientOptions() {
  const calls = mocks.createClient.mock.calls;
  return calls[calls.length - 1][2] as {
    global: { headers: Record<string, string> };
    auth: { persistSession: boolean; autoRefreshToken: boolean };
  };
}

/** وسائط آخر نداء write_audit. */
function lastRpcArgs() {
  const calls = mocks.rpc.mock.calls;
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("recordLoginAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://supabase.example.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    mocks.rpc.mockResolvedValue({ data: "audit-id", error: null });
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.getRequest.mockReturnValue(
      stubRequest({
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "10.0.0.1, 172.19.0.16",
        "user-agent": "Mozilla/5.0 (probe)",
      }),
    );
  });

  /**
   * The header name is the whole finding. Three proxies sit between this
   * process and PostgREST, and every one of them rewrites the `x-forwarded-*`
   * family — measured, an address sent as `x-forwarded-for` arrived as a
   * Cloudflare edge IP. Migration 207 added `x-danat-client-ip`, which no proxy
   * claims, and this asserts we send that rather than a name that gets
   * overwritten in transit.
   */
  it("forwards the visitor address under a header no proxy rewrites", async () => {
    await recordLoginAttempt({
      identifier: "admin",
      accountId: null,
      actorId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });

    expect(lastClientOptions().global.headers["x-danat-client-ip"]).toBe("203.0.113.9");
    expect(lastClientOptions().global.headers["x-forwarded-for"]).toBeUndefined();
    expect(lastClientOptions().global.headers["cf-connecting-ip"]).toBeUndefined();
  });

  it("falls back to the first element of the forwarding chain", async () => {
    mocks.getRequest.mockReturnValue(
      stubRequest({ "x-forwarded-for": "198.51.100.7, 172.19.0.16" }),
    );

    await recordLoginAttempt({
      identifier: "admin",
      accountId: null,
      actorId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });

    expect(lastClientOptions().global.headers["x-danat-client-ip"]).toBe("198.51.100.7");
  });

  it("carries the user agent, path and method write_audit derives its columns from", async () => {
    await recordLoginAttempt({
      identifier: "admin",
      accountId: null,
      actorId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });

    const headers = lastClientOptions().global.headers;
    expect(headers["user-agent"]).toBe("Mozilla/5.0 (probe)");
    expect(headers["x-danat-request-path"]).toBe("/_serverFn/signInWithIdentifier");
    expect(headers["x-http-method"]).toBe("POST");
  });

  /**
   * Without an actor the row reads "system", which is useless on a screen whose
   * primary filter is the actor. Migration 209 takes it as an argument honoured
   * only for a service_role caller, so the row can name the person without this
   * process ever holding their session.
   */
  it("attributes a successful login to the account without holding its session", async () => {
    await recordLoginAttempt({
      identifier: "admin",
      accountId: "11111111-1111-4111-8111-111111111111",
      actorId: "11111111-1111-4111-8111-111111111111",
      result: "success",
      errorCode: null,
    });

    // Never the visitor's token: migration 209 trusts p_actor_id and the
    // x-danat-* headers only from service_role, which a browser never holds.
    expect(lastClientOptions().global.headers.Authorization).toBeUndefined();
    expect(lastRpcArgs()).toMatchObject({
      p_actor_id: "11111111-1111-4111-8111-111111111111",
      p_action: LOGIN_AUDIT_ACTION,
      p_entity_type: "user",
      p_entity_id: "11111111-1111-4111-8111-111111111111",
      p_result: "success",
      p_error_code: null,
    });
  });

  it("writes a failed attempt with its identifier and error code", async () => {
    await recordLoginAttempt({
      identifier: "96550001234",
      accountId: null,
      actorId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });

    expect(lastRpcArgs()).toMatchObject({
      p_action: LOGIN_AUDIT_ACTION,
      p_entity_id: null,
      p_actor_id: null,
      p_after: { identifier: "96550001234" },
      p_result: "failure",
      p_error_code: "INVALID_CREDENTIALS",
    });
  });

  /**
   * The same ticker bug that revoked browser sessions from
   * `signInWithIdentifier` is reachable by any per-request server-side client.
   */
  it("never starts a refresh ticker on its per-request client", async () => {
    await recordLoginAttempt({
      identifier: "admin",
      accountId: null,
      actorId: "11111111-1111-4111-8111-111111111111",
      result: "success",
      errorCode: null,
    });

    expect(lastClientOptions().auth.autoRefreshToken).toBe(false);
    expect(lastClientOptions().auth.persistSession).toBe(false);
  });

  it("still writes a row when there is no request context to read headers from", async () => {
    mocks.getRequest.mockImplementation(() => {
      throw new Error("no request context");
    });

    await recordLoginAttempt({
      identifier: "admin",
      accountId: null,
      actorId: null,
      result: "failure",
      errorCode: "INVALID_CREDENTIALS",
    });

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(lastClientOptions().global.headers["x-danat-client-ip"]).toBeUndefined();
  });

  /** An audit outage must never become an outage of the login form. */
  it("resolves when the audit write itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rpc.mockRejectedValue(new Error("PostgREST is down"));

    await expect(
      recordLoginAttempt({
        identifier: "admin",
        accountId: null,
        actorId: null,
        result: "failure",
        errorCode: "INVALID_CREDENTIALS",
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
