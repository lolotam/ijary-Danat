import { describe, expect, it } from "vitest";

import { createGatewayRegistry, GatewayRegistryError } from "./registry";
import type { GatewayConnection, PaymentGateway } from "./types";

/**
 * يبني محول وهمي صغير يفي بعقد PaymentGateway دون أي اتصال خارجي —
 * السجل لا يستدعي أي عملية من عمليات المحول، فكلها ترمي إن استُدعيت.
 */
function fakeGateway(): PaymentGateway {
  /** يبني عملية ترمي خطأً فور استدعائها لأن السجل لا ينبغي أن ينفذها. */
  const notCalled = (operation: string): (() => Promise<never>) => {
    return async () => {
      throw new Error(`${operation} must not be called by the registry`);
    };
  };
  return {
    supportedMethods: ["knet"],
    createPayment: notCalled("createPayment"),
    getPaymentStatus: notCalled("getPaymentStatus"),
    verifyWebhook: notCalled("verifyWebhook"),
    parseWebhook: notCalled("parseWebhook"),
    testConnection: notCalled("testConnection"),
  };
}

/**
 * يبني اتصال بوابة صالحاً للاختبار بأسرار وهمية باسم واحد.
 */
function fakeConnection(): GatewayConnection {
  return {
    provider: "myfatoorah",
    mode: "test",
    credentials: { apiKey: "test-api-key" },
    publicConfig: { enabledMethods: ["knet"] },
  };
}

describe("createGatewayRegistry", () => {
  it("returns the registered factory for a provider key", () => {
    const factory = () => fakeGateway();
    const registry = createGatewayRegistry({ myfatoorah: factory });

    expect(registry.getFactory("myfatoorah")).toBe(factory);
  });

  it("builds the adapter with the connection it was given", () => {
    const seen: GatewayConnection[] = [];
    const registry = createGatewayRegistry({
      myfatoorah: (connection) => {
        seen.push(connection);
        return fakeGateway();
      },
    });
    const connection = fakeConnection();

    const gateway = registry.create(connection);

    expect(seen).toEqual([connection]);
    expect(gateway.supportedMethods).toEqual(["knet"]);
  });

  it.each(["paypal", "MYFATOORAH", "Tap", "", "myfatoorah "])(
    "throws a typed error for the unknown provider key %j",
    (provider) => {
      const registry = createGatewayRegistry({ myfatoorah: () => fakeGateway() });

      let caught: unknown;
      try {
        registry.getFactory(provider);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GatewayRegistryError);
      const registryError = caught as GatewayRegistryError;
      expect(registryError.code).toBe("UNKNOWN_PROVIDER");
      expect(registryError.provider).toBe(provider);
      expect(registryError.name).toBe("GatewayRegistryError");
    },
  );

  it.each(["myfatoorah", "tap", "upayments"])(
    "throws a typed error for the known provider %s when no adapter is registered",
    (provider) => {
      const registry = createGatewayRegistry({});

      let caught: unknown;
      try {
        registry.getFactory(provider);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(GatewayRegistryError);
      const registryError = caught as GatewayRegistryError;
      expect(registryError.code).toBe("NO_ADAPTER");
      expect(registryError.provider).toBe(provider);
    },
  );
});
