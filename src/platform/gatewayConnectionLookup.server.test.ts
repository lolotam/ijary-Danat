import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ maybeSingle: vi.fn(), eq: vi.fn(), from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { lookupGatewayConnectionOwner } from "./gatewayConnectionLookup.server";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle });
  mocks.from.mockReturnValue({ select: () => ({ eq: mocks.eq }) });
});

describe("lookupGatewayConnectionOwner", () => {
  it("returns the owning company and provider of a known connection", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { company_id: COMPANY_ID, provider: "myfatoorah" },
      error: null,
    });

    await expect(lookupGatewayConnectionOwner(CONNECTION_ID)).resolves.toEqual({
      companyId: COMPANY_ID,
      provider: "myfatoorah",
    });
    expect(mocks.eq).toHaveBeenCalledWith("id", CONNECTION_ID);
  });

  it.each([
    ["an unknown connection", null],
    ["a connection on an unsupported provider", { company_id: COMPANY_ID, provider: "paypal" }],
  ])("returns null for %s so the webhook answers 404", async (_label, row) => {
    mocks.maybeSingle.mockResolvedValue({ data: row, error: null });

    await expect(lookupGatewayConnectionOwner(CONNECTION_ID)).resolves.toBeNull();
  });

  it("throws on a database error instead of reporting the connection as missing", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });

    await expect(lookupGatewayConnectionOwner(CONNECTION_ID)).rejects.toThrow(
      "gateway connection lookup failed: timeout",
    );
  });
});
