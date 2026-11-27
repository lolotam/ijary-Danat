import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

import { encodeByteaHex } from "@/gateways/connectionStore.server";
import type { WhatsappConnectionRow } from "@/integrations/supabase/database.types";
import { decryptSecret } from "@/lib/secrets.server";
import { META_GRAPH_API_VERSION } from "@/whatsapp/cloudApi";
import {
  COEXISTENCE_FEATURE_TYPE,
  EmbeddedSignupError,
  completeEmbeddedSignup,
  getEmbeddedSignupConfig,
  saveCloudCredentials,
} from "@/whatsapp/embeddedSignup";

const MASTER_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_NUMBER_ID = "109876543210";
const WABA_ID = "987654321098";

interface FakeSecretRow {
  company_id: string;
  owner_kind: string;
  owner_id: string;
  name: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  last4: string;
  version: number;
}

/**
 * يبني عميل Supabase وهمياً في الذاكرة لجدولي `whatsapp_connections` و`company_secrets`.
 */
function createFakeDb(options?: {
  initialConnections?: WhatsappConnectionRow[];
  simulatePhoneInUseConstraint?: boolean;
}) {
  const connections: WhatsappConnectionRow[] = (options?.initialConnections ?? []).map((row) => ({
    ...row,
  }));
  const secrets: FakeSecretRow[] = [];

  function makeBuilder(table: "whatsapp_connections" | "company_secrets") {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;
    let orderDesc = false;
    let limitCount: number | null = null;

    const execute = (): { data: unknown; error: { message: string; code?: string } | null } => {
      if (table === "company_secrets") {
        if (pendingInsert) {
          const row = pendingInsert as unknown as FakeSecretRow;
          secrets.push(row);
          return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
        }
        let matched = secrets.filter((row) =>
          filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
        );
        if (orderDesc) {
          matched = [...matched].sort((a, b) => b.version - a.version);
        }
        if (limitCount !== null) {
          matched = matched.slice(0, limitCount);
        }
        return {
          data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
          error: null,
        };
      }

      if (pendingInsert) {
        if (options?.simulatePhoneInUseConstraint && pendingInsert.is_active === true) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "whatsapp_connections_active_phone_number_id_uidx"',
            },
          };
        }
        const now = "2026-11-28T00:00:00.000Z";
        const row: WhatsappConnectionRow = {
          id: CONNECTION_ID,
          company_id: pendingInsert.company_id as string,
          method: pendingInsert.method as WhatsappConnectionRow["method"],
          is_active: (pendingInsert.is_active as boolean) ?? false,
          status: (pendingInsert.status as WhatsappConnectionRow["status"]) ?? "disconnected",
          connected_number: (pendingInsert.connected_number as string | null) ?? null,
          instance_name: (pendingInsert.instance_name as string | null) ?? null,
          phone_number_id: (pendingInsert.phone_number_id as string | null) ?? null,
          waba_id: (pendingInsert.waba_id as string | null) ?? null,
          last_qr: null,
          last_seen_at: null,
          last_error: (pendingInsert.last_error as string | null) ?? null,
          disconnect_alert_armed: false,
          disconnected_at: null,
          connected_at: (pendingInsert.connected_at as string | null) ?? null,
          created_at: now,
          updated_at: now,
        };
        connections.push(row);
        return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
      }

      const matched = connections.filter((row) =>
        filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
      );

      if (pendingUpdate) {
        if (options?.simulatePhoneInUseConstraint && pendingUpdate.is_active === true) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                'duplicate key value violates unique constraint "whatsapp_connections_active_phone_number_id_uidx"',
            },
          };
        }
        for (const row of matched) {
          Object.assign(row, pendingUpdate);
        }
        return {
          data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
          error: null,
        };
      }

      return {
        data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
        error: null,
      };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (values: Record<string, unknown>) => {
        pendingInsert = values;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        pendingUpdate = values;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        filters.push((row) => row[col] !== val);
        return builder;
      },
      order: (_col: string, opts?: { ascending?: boolean }) => {
        orderDesc = opts?.ascending === false;
        return builder;
      },
      limit: (count: number) => {
        limitCount = count;
        return builder;
      },
      single: () => {
        wantSingle = true;
        return Promise.resolve(execute());
      },
      maybeSingle: () => {
        wantMaybeSingle = true;
        return Promise.resolve(execute());
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(onFulfilled, onRejected),
    };

    return builder;
  }

  return {
    connections,
    secrets,
    from: vi.fn((table: "whatsapp_connections" | "company_secrets") => makeBuilder(table)),
  };
}

describe("WhatsApp Embedded Signup (T167)", () => {
  beforeEach(() => {
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", MASTER_KEY_B64);
    vi.stubEnv("META_APP_ID", "meta-app-123");
    vi.stubEnv("META_APP_SECRET", "meta-secret-xyz");
    vi.stubEnv("META_EMBEDDED_SIGNUP_CONFIG_ID", "meta-config-456");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test.each([
    {
      coexistence: true,
      expectedExtras: {
        featureType: COEXISTENCE_FEATURE_TYPE,
        sessionInfoVersion: "3",
      },
    },
    {
      coexistence: false,
      expectedExtras: {
        sessionInfoVersion: "3",
      },
    },
  ])(
    "returns public SDK config without app secret when coexistence=$coexistence",
    ({ coexistence, expectedExtras }) => {
      const config = getEmbeddedSignupConfig({ coexistence });

      expect(config).toEqual({
        appId: "meta-app-123",
        configId: "meta-config-456",
        graphApiVersion: META_GRAPH_API_VERSION,
        extras: expectedExtras,
      });
      expect(JSON.stringify(config)).not.toContain("meta-secret-xyz");
    },
  );

  test.each([{ missingVar: "META_APP_ID" }, { missingVar: "META_EMBEDDED_SIGNUP_CONFIG_ID" }])(
    "throws META_CONFIG_MISSING when $missingVar is unset",
    ({ missingVar }) => {
      vi.stubEnv(missingVar, "");

      expect(() => getEmbeddedSignupConfig({ coexistence: true })).toThrowError(
        EmbeddedSignupError,
      );
      try {
        getEmbeddedSignupConfig({ coexistence: true });
      } catch (err) {
        expect(err).toBeInstanceOf(EmbeddedSignupError);
        expect((err as EmbeddedSignupError).code).toBe("META_CONFIG_MISSING");
      }
    },
  );

  test.each([
    {
      flow: "coexistence",
      coexistence: true,
      method: "cloud_coexistence",
      steps: ["oauth/access_token", "phone_numbers", "subscribed_apps"],
    },
    {
      flow: "a new Cloud API number",
      coexistence: false,
      method: "cloud_api",
      steps: ["oauth/access_token", "phone_numbers", "register", "subscribed_apps"],
    },
  ])(
    "for $flow: exchanges the code, calls $steps, encrypts the token, and activates the connection",
    async ({ coexistence, method, steps }) => {
      const db = createFakeDb({
        initialConnections: [
          {
            id: OTHER_CONNECTION_ID,
            company_id: COMPANY_ID,
            method: "evolution_qr",
            is_active: true,
            status: "connected",
            connected_number: "96550000001",
            instance_name: "ijary-old",
            phone_number_id: null,
            waba_id: null,
            last_qr: null,
            last_seen_at: null,
            last_error: null,
            disconnect_alert_armed: false,
            disconnected_at: null,
            connected_at: "2026-11-01T00:00:00.000Z",
            created_at: "2026-11-01T00:00:00.000Z",
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        ],
      });

      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "EAAG_live_business_token_9988" }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: PHONE_NUMBER_ID }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

      const connection = await completeEmbeddedSignup(
        {
          companyId: COMPANY_ID,
          code: "oauth-code-1",
          phoneNumberId: PHONE_NUMBER_ID,
          wabaId: WABA_ID,
          coexistence,
        },
        {
          db: db as never,
          lookupConnection: async () => null,
          now: () => new Date("2026-11-28T01:00:00.000Z"),
        },
      );

      expect(connection.method).toBe(method);
      expect(connection.is_active).toBe(true);
      expect(connection.status).toBe("connected");
      expect(connection.phone_number_id).toBe(PHONE_NUMBER_ID);
      expect(connection.waba_id).toBe(WABA_ID);

      // Previous active connection was deactivated
      expect(db.connections[0].is_active).toBe(false);

      // Token stored encrypted with last4 and decrypts back to plaintext
      expect(db.secrets).toHaveLength(1);
      expect(db.secrets[0].name).toBe("access_token");
      expect(db.secrets[0].last4).toBe("9988");
      expect(
        decryptSecret({
          ciphertext: Buffer.from(db.secrets[0].ciphertext.slice(2), "hex"),
          iv: Buffer.from(db.secrets[0].iv.slice(2), "hex"),
          authTag: Buffer.from(db.secrets[0].auth_tag.slice(2), "hex"),
          keyVersion: db.secrets[0].key_version,
        }),
      ).toBe("EAAG_live_business_token_9988");

      // Verify Graph API endpoints called
      // Coexistence numbers stay registered to the WhatsApp Business app: no `/register`.
      const calledSteps = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([url]) => String(url).split("?")[0].split("/").pop());
      expect(calledSteps).toEqual(steps.map((step) => step.split("/").pop()));
    },
  );

  test.each([
    {
      step: "token exchange",
      responses: [
        new Response(
          JSON.stringify({ error: { message: "Invalid verification code", code: 100 } }),
          { status: 400 },
        ),
      ],
      expectedMessage: "Invalid verification code",
    },
    {
      step: "phone registration",
      responses: [
        new Response(JSON.stringify({ access_token: "EAAG_tok" }), { status: 200 }),
        new Response(JSON.stringify({ data: [{ id: PHONE_NUMBER_ID }] }), { status: 200 }),
        new Response(
          JSON.stringify({ error: { message: "Phone number not eligible", code: 133010 } }),
          { status: 400 },
        ),
      ],
      expectedMessage: "Phone number not eligible",
    },
    {
      step: "WABA subscription",
      responses: [
        new Response(JSON.stringify({ access_token: "EAAG_tok" }), { status: 200 }),
        new Response(JSON.stringify({ data: [{ id: PHONE_NUMBER_ID }] }), { status: 200 }),
        new Response(JSON.stringify({ success: true }), { status: 200 }),
        new Response(JSON.stringify({ error: { message: "WABA permission denied", code: 200 } }), {
          status: 403,
        }),
      ],
      expectedMessage: "WABA permission denied",
    },
  ])(
    "maps Meta Graph error on $step with Meta's message",
    async ({ responses, expectedMessage }) => {
      const db = createFakeDb();
      const fetchMock = vi.mocked(globalThis.fetch);
      for (const res of responses) {
        fetchMock.mockResolvedValueOnce(res);
      }

      await expect(
        completeEmbeddedSignup(
          {
            companyId: COMPANY_ID,
            code: "bad-code",
            phoneNumberId: PHONE_NUMBER_ID,
            wabaId: WABA_ID,
          },
          {
            db: db as never,
            lookupConnection: async () => null,
          },
        ),
      ).rejects.toThrow(expectedMessage);
    },
  );

  it("throws NUMBER_IN_USE when phoneNumberId is active on another company", async () => {
    const db = createFakeDb();

    await expect(
      completeEmbeddedSignup(
        {
          companyId: COMPANY_ID,
          code: "oauth-code-1",
          phoneNumberId: PHONE_NUMBER_ID,
          wabaId: WABA_ID,
        },
        {
          db: db as never,
          lookupConnection: async () => ({
            id: OTHER_CONNECTION_ID,
            company_id: OTHER_COMPANY_ID,
            method: "cloud_api",
            is_active: true,
            status: "connected",
            instance_name: null,
            phone_number_id: PHONE_NUMBER_ID,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "NUMBER_IN_USE" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("maps Postgres active phone_number_id unique constraint error to NUMBER_IN_USE", async () => {
    const db = createFakeDb({ simulatePhoneInUseConstraint: true });
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "EAAG_tok_1234" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: PHONE_NUMBER_ID }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await expect(
      completeEmbeddedSignup(
        {
          companyId: COMPANY_ID,
          code: "oauth-code-1",
          phoneNumberId: PHONE_NUMBER_ID,
          wabaId: WABA_ID,
        },
        {
          db: db as never,
          lookupConnection: async () => null,
        },
      ),
    ).rejects.toMatchObject({ code: "NUMBER_IN_USE" });
  });

  it("saves manual Cloud API credentials encrypted after Meta confirms the number", async () => {
    const db = createFakeDb();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: PHONE_NUMBER_ID }] }), { status: 200 }),
    );

    const saved = await saveCloudCredentials(
      {
        companyId: COMPANY_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        accessToken: "EAAG_manual_secret_4321",
      },
      {
        db: db as never,
        lookupConnection: async () => null,
      },
    );

    expect(saved.method).toBe("cloud_api");
    expect(saved.is_active).toBe(true);
    expect(saved.status).toBe("connected");
    expect(db.secrets).toHaveLength(1);
    expect(db.secrets[0].last4).toBe("4321");

    // Verify encodeByteaHex round-trip
    expect(db.secrets[0].ciphertext).toMatch(/^\\x[0-9a-f]+$/i);
    expect(encodeByteaHex(Buffer.from(db.secrets[0].ciphertext.slice(2), "hex"))).toBe(
      db.secrets[0].ciphertext,
    );
  });

  // Squatting guard: a company must not claim a phone_number_id it does not own.
  test.each([{ run: "save" as const }, { run: "complete" as const }])(
    "refuses a phone number Meta does not list under the WABA (run=$run)",
    async ({ run }) => {
      const db = createFakeDb();
      const fetchMock = vi.mocked(globalThis.fetch);
      if (run === "complete") {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "EAAG_tok" }), { status: 200 }),
        );
      }
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "someone-elses-number" }] }), { status: 200 }),
      );
      const deps = { db: db as never, lookupConnection: async () => null };

      const attempt =
        run === "save"
          ? saveCloudCredentials(
              {
                companyId: COMPANY_ID,
                phoneNumberId: PHONE_NUMBER_ID,
                wabaId: WABA_ID,
                accessToken: "EAAG_manual_secret_4321",
              },
              deps,
            )
          : completeEmbeddedSignup(
              {
                companyId: COMPANY_ID,
                code: "oauth-code-1",
                phoneNumberId: PHONE_NUMBER_ID,
                wabaId: WABA_ID,
                coexistence: true,
              },
              deps,
            );

      await expect(attempt).rejects.toMatchObject({ code: "NUMBER_NOT_IN_WABA" });
      expect(db.connections).toHaveLength(0);
      expect(db.secrets).toHaveLength(0);
    },
  );
});
