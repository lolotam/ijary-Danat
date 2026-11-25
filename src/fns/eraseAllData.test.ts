import { describe, it, expect, vi } from "vitest";

// Mock createServerFn before importing the module under test
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => {
    return fn._handler({ data, context: fn._context });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

import { eraseAllData } from "./eraseAllData";

describe("eraseAllData server function", () => {
  it("executes erase_all_data RPC when user is an admin", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName, params) => {
      if (rpcName === "has_role") {
        return { data: true, error: null };
      }
      if (rpcName === "erase_all_data") {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
    };

    const gFn = eraseAllData as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-admin-id",
    };

    const result = await gFn(undefined);

    expect(mockRpc).toHaveBeenCalledWith("has_role", {
      _user_id: "test-admin-id",
      _role: "admin",
    });
    expect(mockRpc).toHaveBeenCalledWith("erase_all_data");
    expect(result).toEqual({ success: true });
  });

  it("throws 403 Forbidden when user is not an admin", async () => {
    const mockRpc = vi.fn().mockImplementation((rpcName) => {
      if (rpcName === "has_role") {
        return { data: false, error: null };
      }
      return { data: null, error: null };
    });

    const mockSupabase = {
      rpc: mockRpc,
    };

    const gFn = eraseAllData as any;
    gFn._context = {
      supabase: mockSupabase,
      userId: "test-user-id",
    };

    await expect(gFn(undefined)).rejects.toThrow();
  });
});
