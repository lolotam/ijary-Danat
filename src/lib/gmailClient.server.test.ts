/**
 * تجديد رمز Gmail يتوقف بعد المهلة بدل انتظار Google إلى ما لا نهاية.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubHungFetch } from "@/lib/providers/hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: () => ({
    companyId: "11111111-1111-4111-8111-111111111111",
    client: {},
  }),
}));

const { getGmailAccessToken } = await import("@/lib/gmailClient.server");

describe("getGmailAccessToken", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives up on a token endpoint that never answers", async () => {
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const refresh = getGmailAccessToken({
      address: "me",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
    fireTimeout();

    await expect(refresh).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
  });
});
