import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companyClient, signCompanyServiceToken } from "@/company/companyClient.server";
import { isCompanyContextError } from "@/company/errors";

const TEST_COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const TEST_JWT_SECRET = "test-supabase-jwt-secret-at-least-32-characters";
const TEST_SUPABASE_URL = "https://supabase.test.local";
const TEST_PUBLISHABLE_KEY = "test-publishable-anon-key";
const TEST_SERVICE_ROLE_KEY = "test-service-role-key-must-never-be-sent";

const ENV_KEYS = [
  "SUPABASE_URL",
  "SELF_SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SELF_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "SELF_SUPABASE_JWT_SECRET",
] as const;

describe("companyClient", () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.SUPABASE_URL = TEST_SUPABASE_URL;
    process.env.SUPABASE_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
    process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
    delete process.env.SELF_SUPABASE_URL;
    delete process.env.SELF_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SELF_SUPABASE_JWT_SECRET;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("throws COMPANY_REQUIRED when companyId is empty or not a UUID", () => {
    const invalidInputs = ["", "   ", "not-a-uuid", "11111111-2222-4333-8444-55555555555"];
    for (const badId of invalidInputs) {
      let caught: unknown;
      try {
        companyClient(badId);
      } catch (err) {
        caught = err;
      }
      expect(isCompanyContextError(caught, "COMPANY_REQUIRED")).toBe(true);
    }

    expect(() => companyClient(undefined as unknown as string)).toThrow(
      /Company context is required/,
    );
  });

  it("throws when SUPABASE_JWT_SECRET is missing", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => companyClient(TEST_COMPANY_ID)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  // Regression (T052i): a missing URL used to fall back to localhost and send
  // company traffic to whatever answered on that port.
  it.each(["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] as const)(
    "refuses to build a client when %s is missing instead of falling back",
    (key) => {
      delete process.env[key];
      expect(() => companyClient(TEST_COMPANY_ID)).toThrow(
        /Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY/,
      );
    },
  );

  it("signs a 5-minute HS256 JWT with role company_service and company_id without allow_suspended", async () => {
    const token = await signCompanyServiceToken(TEST_COMPANY_ID);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(TEST_JWT_SECRET),
    );

    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.role).toBe("company_service");
    expect(payload.company_id).toBe(TEST_COMPANY_ID);
    expect(payload.allow_suspended).toBeUndefined();
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("includes allow_suspended: true only when opts.allowSuspended is true", async () => {
    const omitted = await signCompanyServiceToken(TEST_COMPANY_ID, {});
    const falseOpt = await signCompanyServiceToken(TEST_COMPANY_ID, { allowSuspended: false });
    const trueOpt = await signCompanyServiceToken(TEST_COMPANY_ID, { allowSuspended: true });

    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const decodedOmitted = (await jwtVerify(omitted, secret)).payload;
    const decodedFalse = (await jwtVerify(falseOpt, secret)).payload;
    const decodedTrue = (await jwtVerify(trueOpt, secret)).payload;

    expect(decodedOmitted.allow_suspended).toBeUndefined();
    expect(decodedFalse.allow_suspended).toBeUndefined();
    expect(decodedTrue.allow_suspended).toBe(true);
  });

  it("sends the signed company_service JWT and publishable key (never service_role) on queries", async () => {
    const capturedRequests: Array<{ url: string; headers: Headers }> = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify([{ id: TEST_COMPANY_ID }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = companyClient(TEST_COMPANY_ID, { allowSuspended: true });
    const { data, error } = await client.from("companies").select("id");

    expect(error).toBeNull();
    expect(data).toEqual([{ id: TEST_COMPANY_ID }]);
    expect(capturedRequests).toHaveLength(1);

    const req = capturedRequests[0];
    expect(req.headers.get("apikey")).toBe(TEST_PUBLISHABLE_KEY);
    expect(req.headers.get("apikey")).not.toBe(TEST_SERVICE_ROLE_KEY);

    const auth = req.headers.get("Authorization");
    expect(auth).toMatch(/^Bearer /);
    const bearer = auth!.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(TEST_JWT_SECRET));
    expect(payload.role).toBe("company_service");
    expect(payload.company_id).toBe(TEST_COMPANY_ID);
    expect(payload.allow_suspended).toBe(true);
  });

  it("supports SELF_SUPABASE_* aliases when plain SUPABASE_* vars are unset", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.SELF_SUPABASE_URL = "https://self.supabase.test.local";
    process.env.SELF_SUPABASE_PUBLISHABLE_KEY = "self-publishable-key";
    process.env.SELF_SUPABASE_JWT_SECRET = TEST_JWT_SECRET;

    const capturedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders.push(new Headers(init?.headers));
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = companyClient(TEST_COMPANY_ID);
    await client.from("companies").select("id");

    expect(capturedHeaders[0].get("apikey")).toBe("self-publishable-key");
    const token = capturedHeaders[0].get("Authorization")!.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_JWT_SECRET));
    expect(payload.company_id).toBe(TEST_COMPANY_ID);
    expect(payload.allow_suspended).toBeUndefined();
  });

  it("reuses cached token within validity window and refreshes before 5-minute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));

    const authHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = companyClient(TEST_COMPANY_ID);
    await client.from("companies").select("id");
    vi.advanceTimersByTime(60_000);
    await client.from("companies").select("id");

    expect(authHeaders[0]).toBe(authHeaders[1]);

    // Advance past the 30-second refresh buffer (at 4m35s) so a fresh JWT is minted.
    vi.advanceTimersByTime(215_000);
    await client.from("companies").select("id");

    expect(authHeaders[2]).not.toBe(authHeaders[0]);
  });
});
