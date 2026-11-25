import { describe, expect, it, vi } from "vitest";

import { PORTAL_QUERY_KEYS } from "@/lib/portalQueryKeys";

import { useConfirmPayment } from "./useConfirmPayment";

const { useQueryClientMock, useMutationMock, confirmPaymentForCurrentSessionMock } = vi.hoisted(
  () => ({
    useQueryClientMock: vi.fn(),
    useMutationMock: vi.fn(),
    confirmPaymentForCurrentSessionMock: vi.fn(),
  }),
);

let registeredOnSuccess:
  | ((result: { status: "paid" | "pending" | "failed"; tenantId: string }) => unknown)
  | null = null;

vi.mock("@tanstack/react-query", () => ({
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
}));

vi.mock("@/lib/myfatoorah", () => ({
  confirmPaymentForCurrentSession: confirmPaymentForCurrentSessionMock,
}));

useMutationMock.mockImplementation((config: { onSuccess?: typeof registeredOnSuccess }) => {
  registeredOnSuccess = config?.onSuccess ?? null;
  return { mutate: vi.fn() };
});

describe("useConfirmPayment invalidation", () => {
  it("invalidates every portal cache when the gateway reports the payment as paid", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    useQueryClientMock.mockReturnValue({ invalidateQueries });

    useConfirmPayment();

    expect(registeredOnSuccess).not.toBeNull();
    await registeredOnSuccess!({ status: "paid", tenantId: "tenant-1" });

    // By prefix, so the confirmed tenant's keys and any staff preview are both
    // covered — asserted on the exact names, not a bare toHaveBeenCalled.
    const invalidated = invalidateQueries.mock.calls.map(([arg]) => arg.queryKey);
    expect(invalidated).toEqual(PORTAL_QUERY_KEYS.map((key) => [key]));
  });

  it("does not invalidate caches when the payment is still pending or failed", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    useQueryClientMock.mockReturnValue({ invalidateQueries });

    useConfirmPayment();
    await registeredOnSuccess!({ status: "pending", tenantId: "tenant-1" });
    await registeredOnSuccess!({ status: "failed", tenantId: "tenant-1" });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
