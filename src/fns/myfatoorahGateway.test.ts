import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { gatewayConfigFromEnv } from "./myfatoorahGateway";

describe("gatewayConfigFromEnv", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env = { ...originalEnv };
    delete process.env.MYFATOORAH_API_KEY;
    delete process.env.MYFATOORAH_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  // Regression guard for the audit finding: this used to
  // `throw new Response(..., { status: 503 })`, which TanStack Start hands back
  // to the caller instead of rejecting — the portal's await resolved on a
  // missing configuration and it redirected to `undefined`. The refusal must be
  // an `Error`, never a `Response`, and no gateway request may start: a config
  // that was never built must not be able to reach MyFatoorah.
  it("rejects with an Error, not a Response, when the API key is unset", async () => {
    let thrown: unknown;
    try {
      gatewayConfigFromEnv();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(Response);
    expect(thrown).toHaveProperty(
      "message",
      "MyFatoorah is not configured. Set MYFATOORAH_API_KEY.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Compose renders an unset variable as "" rather than removing it, so the
  // empty string is the production shape of "not configured".
  it("rejects when the API key is an empty string", () => {
    process.env.MYFATOORAH_API_KEY = "";

    expect(() => gatewayConfigFromEnv()).toThrow(
      "MyFatoorah is not configured. Set MYFATOORAH_API_KEY.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the key with the default base URL when configured", () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";

    expect(gatewayConfigFromEnv()).toEqual({
      apiKey: "test-api-key",
      baseUrl: "https://api.myfatoorah.com",
    });
  });

  it("honours an explicit base URL override", () => {
    process.env.MYFATOORAH_API_KEY = "test-api-key";
    process.env.MYFATOORAH_BASE_URL = "https://apitest.myfatoorah.com";

    expect(gatewayConfigFromEnv()).toEqual({
      apiKey: "test-api-key",
      baseUrl: "https://apitest.myfatoorah.com",
    });
  });
});
