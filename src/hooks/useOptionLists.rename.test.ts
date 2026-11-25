import { describe, expect, it, vi } from "vitest";

import { useOptionListValueUsage, useRenameOptionListValue } from "./useOptionLists";

const { useQueryClientMock, useMutationMock, rpcMock } = vi.hoisted(() => ({
  useQueryClientMock: vi.fn(),
  useMutationMock: vi.fn(),
  rpcMock: vi.fn(),
}));

type MutationConfig = {
  mutationFn: (variables: any) => Promise<unknown>;
  onSuccess?: (result: unknown) => unknown;
};

const registered: MutationConfig[] = [];

vi.mock("@tanstack/react-query", () => ({
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
  useQuery: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

useMutationMock.mockImplementation((config: MutationConfig) => {
  registered.push(config);
  return { mutate: vi.fn(), mutateAsync: (variables: unknown) => config.mutationFn(variables) };
});

/** آخر إعداد مسجّل — تُستدعى الخطافات مباشرة داخل it كما في useConfirmPayment.test. */
function lastRegistered(): MutationConfig {
  const config = registered.at(-1);
  if (!config) throw new Error("mutation config was not registered");
  return config;
}

describe("useOptionListValueUsage", () => {
  it("counts through the preview RPC with the item id", async () => {
    rpcMock.mockResolvedValue({ data: { "units.type": 2 }, error: null });
    registered.length = 0;
    useOptionListValueUsage();

    const result = await lastRegistered().mutationFn("item-1");

    expect(rpcMock).toHaveBeenCalledWith("count_option_list_value_usage", {
      p_item_id: "item-1",
    });
    expect(result).toEqual({ "units.type": 2 });
  });

  it("throws the preview error instead of returning it", async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error("denied") });
    registered.length = 0;
    useOptionListValueUsage();

    await expect(lastRegistered().mutationFn("item-1")).rejects.toThrow("denied");
  });
});

describe("useRenameOptionListValue", () => {
  it("renames through the cascade RPC with the item id and new value", async () => {
    rpcMock.mockResolvedValue({ data: { updated: { "units.type": 2 } }, error: null });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    registered.length = 0;
    useRenameOptionListValue();

    const result = await lastRegistered().mutationFn({ itemId: "item-1", newValue: "shops" });

    expect(rpcMock).toHaveBeenCalledWith("rename_option_list_value", {
      p_item_id: "item-1",
      p_new_value: "shops",
    });
    expect(result).toEqual({ updated: { "units.type": 2 } });
  });

  it("invalidates every query root that can show a stored list value", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    useQueryClientMock.mockReturnValue({ invalidateQueries });
    registered.length = 0;
    useRenameOptionListValue();

    await lastRegistered().onSuccess?.({ updated: {} });

    // Exact roots from the hooks that read stored values — a missing root
    // leaves a table or form showing the pre-rename value until reload.
    const invalidated = invalidateQueries.mock.calls.map(([arg]) => arg.queryKey);
    expect(invalidated).toEqual([
      ["option-lists"],
      ["option-list-items"],
      ["option-list-items-by-code"],
      ["units"],
      ["unit"],
      ["properties"],
      ["property"],
      ["contracts"],
      ["contract"],
      ["deposits"],
      ["gmail-messages"],
      ["gmail-message"],
    ]);
  });
});
