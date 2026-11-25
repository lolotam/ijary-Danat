import { describe, expect, it } from "vitest";

import {
  contractExpiryDeliveryKey,
  isContractExpiryDeliveryComplete,
} from "./contractExpiryDelivery";

describe("contract expiry delivery completion", () => {
  const tenantEmail = {
    audience: "tenant",
    channel: "email",
    milestone: "7d",
    recipientAddress: "tenant@example.com",
  } as const;

  it("allows a failed tenant email to retry after an admin email is sent", () => {
    const completedDeliveries = new Set([
      contractExpiryDeliveryKey({
        audience: "admin",
        channel: "email",
        contractId: "contract-1",
        milestone: "7d",
        recipientAddress: "admin@example.com",
      }),
    ]);

    expect(
      isContractExpiryDeliveryComplete(completedDeliveries, {
        ...tenantEmail,
        contractId: "contract-1",
      }),
    ).toBe(false);
  });

  it("does not enqueue a tenant email that is already sent or queued", () => {
    const completedDeliveries = new Set([
      contractExpiryDeliveryKey({ ...tenantEmail, contractId: "contract-1" }),
    ]);

    expect(
      isContractExpiryDeliveryComplete(completedDeliveries, {
        ...tenantEmail,
        contractId: "contract-1",
      }),
    ).toBe(true);
  });
});
