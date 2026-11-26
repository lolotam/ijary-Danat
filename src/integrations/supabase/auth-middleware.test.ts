/**
 * رفض وسيطة المصادقة يجب أن يرفض على العميل، لا أن يُحلّ كنجاح.
 *
 * A thrown `Response` resolves client-side via `x-tss-raw`; these tests pin
 * that every refusal is an `Error` and that the HTTP status is still set.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const headers = new Map<string, string>();
const setResponseStatus = vi.fn();
const getUser = vi.fn();
const rpc = vi.fn();
const getRequestCompany = vi.fn();

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({ headers: { get: (name: string) => headers.get(name) ?? null } }),
  setResponseStatus: (status: number) => setResponseStatus(status),
}));

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => getRequestCompany(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser }, rpc }),
}));

const { requireSupabaseAuth } = await import("./auth-middleware");

type Middleware = (options: {
  next: (value: { context: { userId: string } }) => unknown;
}) => Promise<unknown>;
const middleware = requireSupabaseAuth as unknown as Middleware;
const next = vi.fn((value: unknown) => value);

const COMPANY_A = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  status: "active" as const,
  host: "acme.localhost",
};

beforeEach(() => {
  vi.clearAllMocks();
  headers.clear();
  process.env.SUPABASE_URL = "https://supabase.example.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
  getRequestCompany.mockReturnValue(COMPANY_A);
});

describe("requireSupabaseAuth refusals", () => {
  test.each([
    ["no Authorization header", () => undefined, 401],
    [
      "a token Supabase rejects",
      () => {
        headers.set("authorization", "Bearer expired");
        getUser.mockResolvedValue({ data: { user: null }, error: { message: "jwt expired" } });
      },
      401,
    ],
    [
      "a token belonging to a different company than the request host",
      () => {
        headers.set("authorization", "Bearer company-b");
        getUser.mockResolvedValue({ data: { user: { id: "user-b" } }, error: null });
        rpc.mockResolvedValue({ data: "22222222-2222-4222-8222-222222222222", error: null });
      },
      401,
    ],
    [
      "a platform or unknown host with no resolved request company",
      () => {
        headers.set("authorization", "Bearer good");
        getRequestCompany.mockReturnValue(null);
        getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
        rpc.mockResolvedValue({ data: COMPANY_A.id, error: null });
      },
      401,
    ],
    [
      "a user whose current_company_id resolves to null",
      () => {
        headers.set("authorization", "Bearer good");
        getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
        rpc.mockResolvedValue({ data: null, error: null });
      },
      401,
    ],
    [
      "a server missing its Supabase config",
      () => {
        headers.set("authorization", "Bearer token");
        delete process.env.SUPABASE_URL;
        delete process.env.SELF_SUPABASE_URL;
      },
      500,
    ],
  ])("%s rejects with an Error and sets HTTP %i", async (_label, arrange, status) => {
    arrange();

    const call = middleware({ next });

    await expect(call).rejects.toBeInstanceOf(Error);
    await expect(call).rejects.not.toBeInstanceOf(Response);
    expect(setResponseStatus).toHaveBeenCalledWith(status);
    expect(next).not.toHaveBeenCalled();
  });

  test("a valid token in the request company reaches the handler with the user's id", async () => {
    headers.set("authorization", "Bearer good");
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    rpc.mockResolvedValue({ data: COMPANY_A.id, error: null });

    await middleware({ next });

    expect(rpc).toHaveBeenCalledWith("current_company_id");
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ userId: "user-1" }) }),
    );
    expect(setResponseStatus).not.toHaveBeenCalled();
  });
});
