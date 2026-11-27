import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  callerRpc: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));

import { PLATFORM_ADMIN_REQUIRED, requirePlatformAdmin } from "./requirePlatformAdmin.server";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

/**
 * يبني رمز جلسة يحمل ادعاءً واحداً، كما يفعل GoTrue.
 *
 * The subject is all the guard reads out of the token; the signature is never
 * checked here because the database checks it when the caller's own client
 * runs `is_platform_admin()`.
 */
function makeToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

/** يوفّر طلباً بترويسة `Authorization` واحدة. */
function stubAuthorization(token: string | null) {
  mocks.getRequest.mockReturnValue({
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" && token ? `Bearer ${token}` : null,
    },
  });
}

describe("requirePlatformAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    mocks.createClient.mockReturnValue({ rpc: mocks.callerRpc });
    mocks.callerRpc.mockResolvedValue({ data: true, error: null });
  });

  it("returns the caller's id when the database recognises a platform admin", async () => {
    stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal2" }));

    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: ADMIN_ID });
  });

  it("asks the database through the caller's own client, not through the service role", async () => {
    stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal2" }));

    await requirePlatformAdmin();

    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://supabase.example.test",
      "publishable-key",
      expect.objectContaining({
        global: { headers: { Authorization: expect.stringContaining("Bearer ") } },
      }),
    );
    expect(mocks.callerRpc).toHaveBeenCalledWith("is_platform_admin");
  });

  it("refuses a caller the database does not recognise as a platform admin", async () => {
    stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal1" }));
    mocks.callerRpc.mockResolvedValue({ data: false, error: null });

    await expect(requirePlatformAdmin()).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
  });

  it("refuses when the check itself fails", async () => {
    stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal2" }));
    mocks.callerRpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    await expect(requirePlatformAdmin()).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
  });

  it("refuses a request without a bearer token", async () => {
    stubAuthorization(null);

    await expect(requirePlatformAdmin()).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
  });

  it("refuses when there is no request at all", async () => {
    mocks.getRequest.mockImplementation(() => {
      throw new Error("no request");
    });

    await expect(requirePlatformAdmin()).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
  });

  it("refuses a token that carries no usable subject", async () => {
    stubAuthorization(makeToken({ aal: "aal2" }));

    await expect(requirePlatformAdmin()).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
  });

  it("gives every refusal the same code, so the answer says nothing about the caller", async () => {
    const refusalMessage = () =>
      requirePlatformAdmin().then(
        () => "",
        (error: Error) => error.message,
      );

    stubAuthorization(null);
    const withoutToken = await refusalMessage();

    stubAuthorization(makeToken({ aal: "aal2" }));
    const withoutSubject = await refusalMessage();

    stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal2" }));
    mocks.callerRpc.mockResolvedValue({ data: false, error: null });
    const withoutAdminRow = await refusalMessage();

    expect([withoutToken, withoutSubject, withoutAdminRow]).toEqual([
      PLATFORM_ADMIN_REQUIRED,
      PLATFORM_ADMIN_REQUIRED,
      PLATFORM_ADMIN_REQUIRED,
    ]);
  });
});
