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

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (fn: unknown) => fn }),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({ headers: { get: (name: string) => headers.get(name) ?? null } }),
  setResponseStatus: (status: number) => setResponseStatus(status),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser } }),
}));

const { requireSupabaseAuth } = await import("./auth-middleware");

type Middleware = (options: {
  next: (value: { context: { userId: string } }) => unknown;
}) => Promise<unknown>;
const middleware = requireSupabaseAuth as unknown as Middleware;
const next = vi.fn((value: unknown) => value);

beforeEach(() => {
  vi.clearAllMocks();
  headers.clear();
  process.env.SUPABASE_URL = "https://supabase.example.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable";
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

  test("a valid token reaches the handler with the user's id", async () => {
    headers.set("authorization", "Bearer good");
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    await middleware({ next });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ userId: "user-1" }) }),
    );
    expect(setResponseStatus).not.toHaveBeenCalled();
  });
});
