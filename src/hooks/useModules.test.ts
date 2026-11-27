import { beforeEach, describe, expect, test, vi } from "vitest";

const useQueryMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock("@/fns/myModules", () => ({
  myModules: vi.fn(),
}));

import { DEFAULT_MODULE_ENABLED } from "@/company/modules";
import {
  MODULES_QUERY_KEY,
  MODULES_STALE_TIME_MS,
  resolveModuleEnabled,
  useModules,
} from "@/hooks/useModules";

describe("useModules (T110)", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useAuthMock.mockReset();
  });

  test("configures TanStack Query with staleTime at most 60 seconds", () => {
    useAuthMock.mockReturnValue({ user: { id: "user-1" } });
    useQueryMock.mockReturnValue({ data: undefined, isError: false });

    useModules();

    expect(MODULES_STALE_TIME_MS).toBeLessThanOrEqual(60_000);
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: MODULES_QUERY_KEY,
        enabled: true,
        staleTime: MODULES_STALE_TIME_MS,
      }),
    );
  });

  test("disables query when no user is signed in", () => {
    useAuthMock.mockReturnValue({ user: null });
    useQueryMock.mockReturnValue({ data: undefined, isError: false });

    useModules();

    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  test.each([
    {
      label: "loaded modules override defaults",
      modules: { ...DEFAULT_MODULE_ENABLED, electricity: false, maintenance: true },
      isError: false,
      key: "electricity" as const,
      expected: false,
    },
    {
      label: "loaded modules allow enabled hidden-by-default section",
      modules: { ...DEFAULT_MODULE_ENABLED, maintenance: true },
      isError: false,
      key: "maintenance" as const,
      expected: true,
    },
    {
      label: "loading state falls back to default module visibility",
      modules: undefined,
      isError: false,
      key: "maintenance" as const,
      expected: false,
    },
    {
      label: "error state fails closed",
      modules: undefined,
      isError: true,
      key: "invoices" as const,
      expected: false,
    },
  ])("$label", ({ modules, isError, key, expected }) => {
    const isEnabled = resolveModuleEnabled(modules, isError);
    expect(isEnabled(key)).toBe(expected);
  });
});
