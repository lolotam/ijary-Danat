import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, WhatsappConnectionRow } from "@/integrations/supabase/database.types";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const db = {
  connections: [] as WhatsappConnectionRow[],
  provider: null as Record<string, unknown> | null,
};

/**
 * بديل مبسّط لعميل Supabase: يطبّق المرشِّحات على الصفوف المخزّنة.
 *
 * The database is a system boundary, so it is faked here rather than carried
 * in; what the assertions care about is WHICH row the query can reach.
 */
function createFakeClient(): SupabaseClient<Database> {
  const client = {
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        maybeSingle: async () => {
          const source =
            table === "provider_configs"
              ? db.provider
                ? [db.provider]
                : []
              : (db.connections as unknown as Array<Record<string, unknown>>);
          const matched = source.filter((row) => filters.every((test) => test(row)));
          return { data: matched[0] ?? null, error: null };
        },
      };
      return builder;
    },
  };
  return client as unknown as SupabaseClient<Database>;
}

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => createFakeClient(),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  }),
}));

const { loadEvolutionProviderConfig, loadQrConnection } = await import("./evolutionSession");

function makeConnection(overrides: Partial<WhatsappConnectionRow> = {}): WhatsappConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    company_id: COMPANY_ID,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    connected_number: "96550001111",
    instance_name: "ijary-11111111111111114111111111111111",
    phone_number_id: null,
    waba_id: null,
    last_qr: null,
    last_seen_at: null,
    last_error: null,
    disconnect_alert_armed: false,
    disconnected_at: null,
    connected_at: "2026-11-27T10:00:00.000Z",
    created_at: "2026-11-27T10:00:00.000Z",
    updated_at: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  db.connections = [];
  db.provider = null;
});

describe("loadEvolutionProviderConfig", () => {
  it("reads the provider row even when the provider is switched off", async () => {
    // Pairing first and enabling the toggle later is the natural admin order,
    // so a disabled provider must not hide the row from the QR path.
    db.provider = {
      provider: "evolution_api",
      is_enabled: false,
      config: { api_base: "http://evolution:8080", api_key_env: "EVOLUTION_API_KEY" },
    };

    const config = await loadEvolutionProviderConfig(COMPANY_ID);

    expect(config.provider).toBe("evolution_api");
    expect(config.is_enabled).toBe(false);
  });
});

describe("loadQrConnection", () => {
  it("reads the company's active QR connection", async () => {
    db.connections = [
      makeConnection(),
      makeConnection({
        id: "44444444-4444-4444-8444-444444444444",
        company_id: OTHER_COMPANY_ID,
      }),
    ];

    const row = await loadQrConnection(createFakeClient(), COMPANY_ID);

    expect(row).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      instance_name: "ijary-11111111111111114111111111111111",
      status: "connected",
    });
  });

  it("never reads another company's connection", async () => {
    db.connections = [makeConnection({ company_id: OTHER_COMPANY_ID })];

    const row = await loadQrConnection(createFakeClient(), COMPANY_ID);

    expect(row).toBeNull();
  });

  it("ignores a connection of another method", async () => {
    // The Cloud API row of the same company says nothing about the QR session.
    db.connections = [makeConnection({ method: "cloud_api", instance_name: null })];

    const row = await loadQrConnection(createFakeClient(), COMPANY_ID);

    expect(row).toBeNull();
  });

  it("pins the connection id, so a connection that is no longer active is not read", async () => {
    db.connections = [
      makeConnection(),
      makeConnection({
        id: "55555555-5555-4555-8555-555555555555",
        is_active: false,
        status: "disconnected",
      }),
    ];

    const row = await loadQrConnection(createFakeClient(), COMPANY_ID, {
      connectionId: "55555555-5555-4555-8555-555555555555",
    });

    expect(row).toBeNull();
  });
});
