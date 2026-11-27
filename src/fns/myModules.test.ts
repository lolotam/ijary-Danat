import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = async (input?: { data?: unknown }) => {
      const raw = input?.data;
      const data = fn._schema ? fn._schema.parse(raw) : raw;
      return fn._handler({ data, context: fn._context });
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({
    server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

import { DEFAULT_MODULE_ENABLED } from "@/company/modules";
import { myModules } from "@/fns/myModules";

describe("myModules (T110)", () => {
  const rpcMock = vi.fn();

  beforeEach(() => {
    rpcMock.mockReset();
    (myModules as any)._context = {
      userId: "11111111-1111-4111-8111-111111111111",
      supabase: { rpc: rpcMock },
    };
  });

  test("returns full module map overriding defaults with database rows", async () => {
    rpcMock.mockResolvedValue({
      data: [
        { module_key: "electricity", enabled: false },
        { module_key: "maintenance", enabled: true },
        { module_key: "unknown_future_module", enabled: true },
      ],
      error: null,
    });

    const result = await myModules();

    expect(rpcMock).toHaveBeenCalledWith("get_my_modules");
    expect(result).toEqual({
      ...DEFAULT_MODULE_ENABLED,
      electricity: false,
      maintenance: true,
    });
  });

  test("throws when get_my_modules RPC fails", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied" },
    });

    await expect(myModules()).rejects.toThrow("get_my_modules failed: permission denied");
  });
});
