import { beforeEach, describe, expect, test, vi } from "vitest";

const getSessionMock = vi.fn();
const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: () => getSessionMock() },
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  redirect: vi.fn((opts: unknown) => ({ __redirect: opts })),
}));

import { isCompanyContextError } from "@/company/errors";
import { ADMIN_ROUTE_MODULE_MAP, guardModuleRoute, requireModule } from "@/company/requireModule";

describe("requireModule (T111)", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    rpcMock.mockReset();
  });

  test("allows execution when module_enabled returns true", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) };

    await expect(requireModule(db, "invoices")).resolves.toBeUndefined();
    expect(db.rpc).toHaveBeenCalledWith("module_enabled", { _key: "invoices" });
  });

  test("throws MODULE_DISABLED CompanyContextError when module_enabled returns false", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };

    let caught: unknown;
    try {
      await requireModule(db, "electricity");
    } catch (err) {
      caught = err;
    }

    expect(isCompanyContextError(caught, "MODULE_DISABLED")).toBe(true);
  });

  test("propagates RPC errors from module_enabled", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } }) };

    await expect(requireModule(db, "invoices")).rejects.toThrow("module_enabled(invoices) failed");
  });

  test("guardModuleRoute returns early without session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await expect(guardModuleRoute("invoices")).resolves.toBeUndefined();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  test("guardModuleRoute redirects to /admin when section is disabled", async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    rpcMock.mockResolvedValue({ data: false, error: null });

    await expect(guardModuleRoute("electricity")).rejects.toEqual({
      __redirect: { to: "/admin" },
    });
  });

  test("guardModuleRoute fails closed to /admin when RPC errors", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    rpcMock.mockResolvedValue({ data: null, error: { message: "network error" } });

    await expect(guardModuleRoute("electricity")).rejects.toEqual({
      __redirect: { to: "/admin" },
    });
    errSpy.mockRestore();
  });

  test.each(Object.entries(ADMIN_ROUTE_MODULE_MAP))(
    "route %s maps to section %s",
    (routePath, moduleKey) => {
      expect(ADMIN_ROUTE_MODULE_MAP[routePath as keyof typeof ADMIN_ROUTE_MODULE_MAP]).toBe(
        moduleKey,
      );
      expect(routePath.startsWith("/admin/settings")).toBe(false);
    },
  );
});
