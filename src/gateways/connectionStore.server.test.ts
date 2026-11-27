import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  decodeByteaHex,
  encodeByteaHex,
  GatewayConnectionError,
  loadActiveGatewayConnection,
  loadGatewayConnection,
  saveGatewayCredentials,
} from "@/gateways/connectionStore.server";
import type { Database, GatewayConnectionRow } from "@/integrations/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

interface StoredSecretRow {
  id: string;
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
 * قاعدة بيانات وهمية في الذاكرة تحاكي جداول `gateway_connections` و`company_secrets`
 * مع محاكاة مُشغّل قاعدة البيانات الذي يعطّل الاتصال عند تدوير بيانات الاعتماد.
 */
function createFakeDb(initial?: {
  connections?: GatewayConnectionRow[];
  secrets?: StoredSecretRow[];
}) {
  const connections: GatewayConnectionRow[] = [...(initial?.connections ?? [])];
  const secrets: StoredSecretRow[] = [...(initial?.secrets ?? [])];
  let seq = 1;

  function makeQuery(table: "gateway_connections" | "company_secrets") {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;

    const execute = (): { data: unknown; error: { message: string } | null } => {
      if (table === "gateway_connections") {
        if (pendingInsert) {
          const item = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
          const now = "2026-11-27T10:00:00.000Z";
          const row: GatewayConnectionRow = {
            id: (item.id as string) ?? CONNECTION_ID,
            company_id: item.company_id as string,
            provider: item.provider as GatewayConnectionRow["provider"],
            mode: (item.mode as GatewayConnectionRow["mode"]) ?? "test",
            public_config: (item.public_config as GatewayConnectionRow["public_config"]) ?? {},
            is_active: (item.is_active as boolean) ?? false,
            last_test_at: null,
            last_test_ok: false,
            last_test_message: null,
            credentials_version: (item.credentials_version as number) ?? 1,
            created_at: now,
            updated_at: now,
          };
          connections.push(row);
          return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
        }

        if (pendingUpdate) {
          const matched = connections.filter((row) =>
            filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
          );
          for (const row of matched) {
            const versionChanged =
              pendingUpdate.credentials_version !== undefined &&
              pendingUpdate.credentials_version !== row.credentials_version;
            Object.assign(row, pendingUpdate);
            // Mirrors DB trigger `tg_gateway_connections_guard_activation`.
            if (versionChanged && pendingUpdate.last_test_at === undefined) {
              row.last_test_ok = false;
              row.last_test_at = null;
              row.last_test_message = null;
              row.is_active = false;
            }
          }
          return {
            data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
            error: null,
          };
        }

        const matched = connections.filter((row) =>
          filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
        );
        if (wantMaybeSingle) return { data: matched[0] ?? null, error: null };
        if (wantSingle) {
          return matched[0]
            ? { data: matched[0], error: null }
            : { data: null, error: { message: "Row not found" } };
        }
        return { data: matched, error: null };
      }

      // company_secrets
      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const inserted: StoredSecretRow[] = [];
        for (const item of items) {
          const duplicate = secrets.find(
            (s) =>
              s.owner_kind === item.owner_kind &&
              s.owner_id === item.owner_id &&
              s.name === item.name &&
              s.version === item.version,
          );
          if (duplicate) {
            return {
              data: null,
              error: { message: "duplicate key value violates unique constraint" },
            };
          }
          const row: StoredSecretRow = {
            id: `sec-${seq++}`,
            company_id: item.company_id as string,
            owner_kind: item.owner_kind as string,
            owner_id: item.owner_id as string,
            name: item.name as string,
            ciphertext: item.ciphertext as string,
            iv: item.iv as string,
            auth_tag: item.auth_tag as string,
            key_version: item.key_version as number,
            last4: item.last4 as string,
            version: item.version as number,
          };
          secrets.push(row);
          inserted.push(row);
        }
        return { data: wantSingle ? inserted[0] : inserted, error: null };
      }

      const matched = secrets.filter((row) =>
        filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
      );
      return { data: matched, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return builder;
      },
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        pendingInsert = payload;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        pendingUpdate = payload;
        return builder;
      },
      maybeSingle: () => {
        wantMaybeSingle = true;
        return builder;
      },
      single: () => {
        wantSingle = true;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  }

  const client = {
    from: (table: "gateway_connections" | "company_secrets") => makeQuery(table),
    rpc: async (name: string) => {
      if (name === "current_company_id") return { data: COMPANY_ID, error: null };
      return { data: null, error: null };
    },
  };

  return {
    db: client as unknown as SupabaseClient<Database>,
    connections,
    secrets,
  };
}

const originalMasterKey = process.env.INTEGRATIONS_MASTER_KEY;

beforeEach(() => {
  process.env.INTEGRATIONS_MASTER_KEY = TEST_MASTER_KEY;
});

afterEach(() => {
  if (originalMasterKey === undefined) {
    delete process.env.INTEGRATIONS_MASTER_KEY;
  } else {
    process.env.INTEGRATIONS_MASTER_KEY = originalMasterKey;
  }
});

describe("bytea hex conversion helpers", () => {
  test("round-trips binary buffers through Postgres hex format", () => {
    const raw = Buffer.from([0x00, 0x1a, 0xff, 0x7b, 0x90]);
    const encoded = encodeByteaHex(raw);
    expect(encoded).toBe("\\x001aff7b90");
    expect(decodeByteaHex(encoded).equals(raw)).toBe(true);
  });

  test.each(["deadbeef", "\\xabc", "\\xzzzz", ""])(
    "rejects malformed bytea hex string %j",
    (malformed) => {
      expect(() => decodeByteaHex(malformed)).toThrow(GatewayConnectionError);
    },
  );
});

describe("saveGatewayCredentials and loadGatewayConnection", () => {
  test("round-trips saved credentials into decrypted plaintext", async () => {
    const { db, secrets } = createFakeDb();

    const saved = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: { enabledMethods: ["knet", "card"] },
      credentials: { apiKey: "mf_test_secret_9876", webhookSecret: "wh_sec_4321" },
    });

    expect(saved.credentials_version).toBe(1);
    expect(secrets).toHaveLength(2);
    expect(secrets.every((s) => s.ciphertext.startsWith("\\x"))).toBe(true);
    expect(secrets.find((s) => s.name === "apiKey")?.last4).toBe("9876");

    const loaded = await loadGatewayConnection(db, saved.id);
    expect(loaded).toEqual({
      id: saved.id,
      companyId: COMPANY_ID,
      provider: "myfatoorah",
      mode: "test",
      isActive: false,
      credentialsVersion: 1,
      connection: {
        provider: "myfatoorah",
        mode: "test",
        publicConfig: { enabledMethods: ["knet", "card"] },
        credentials: {
          apiKey: "mf_test_secret_9876",
          webhookSecret: "wh_sec_4321",
        },
      },
    });
  });

  test("bumps credentials_version on rotation and loads only the current version", async () => {
    const { db, connections, secrets } = createFakeDb();

    const v1 = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "old_key_1111" },
    });

    // Simulate a passing test and activation before rotating credentials.
    connections[0].last_test_ok = true;
    connections[0].last_test_at = "2026-11-27T10:05:00.000Z";
    connections[0].is_active = true;

    const v2 = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "live",
      publicConfig: { enabledMethods: ["knet"] },
      credentials: { apiKey: "new_key_2222" },
    });

    expect(v2.credentials_version).toBe(2);
    expect(v2.is_active).toBe(false);
    expect(v2.last_test_ok).toBe(false);
    // Both versions remain stored so in-flight payments on v1 can still settle.
    expect(secrets).toHaveLength(2);

    const loaded = await loadGatewayConnection(db, v1.id);
    expect(loaded.credentialsVersion).toBe(2);
    expect(loaded.connection.credentials).toEqual({ apiKey: "new_key_2222" });
  });

  test("keeps credentials_version unchanged when credentials are identical or omitted", async () => {
    const { db, connections } = createFakeDb();

    await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "same_key_1234" },
    });
    connections[0].last_test_ok = true;
    connections[0].last_test_at = "2026-11-27T10:05:00.000Z";
    connections[0].is_active = true;

    const afterSameCreds = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: { enabledMethods: ["knet"] },
      credentials: { apiKey: "same_key_1234" },
    });
    expect(afterSameCreds.credentials_version).toBe(1);
    expect(afterSameCreds.is_active).toBe(true);

    const afterEmptyCreds = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: { enabledMethods: ["knet", "card"] },
      credentials: {},
    });
    expect(afterEmptyCreds.credentials_version).toBe(1);
    expect(afterEmptyCreds.is_active).toBe(true);
  });

  test("throws CONNECTION_NOT_FOUND when connection row does not exist", async () => {
    const { db } = createFakeDb();
    await expect(loadGatewayConnection(db, CONNECTION_ID)).rejects.toMatchObject({
      name: "GatewayConnectionError",
      code: "CONNECTION_NOT_FOUND",
    });
  });
});

describe("loadActiveGatewayConnection", () => {
  test("returns null when no connection is active", async () => {
    const { db } = createFakeDb();
    await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "mf_test_1234" },
    });

    await expect(loadActiveGatewayConnection(db)).resolves.toBeNull();
  });

  test("returns the active connection with decrypted credentials", async () => {
    const { db, connections } = createFakeDb();
    const saved = await saveGatewayCredentials(db, {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: { enabledMethods: ["knet"] },
      credentials: { apiKey: "mf_active_9999" },
    });
    connections[0].last_test_ok = true;
    connections[0].last_test_at = "2026-11-27T10:05:00.000Z";
    connections[0].is_active = true;

    const active = await loadActiveGatewayConnection(db);
    expect(active?.id).toBe(saved.id);
    expect(active?.isActive).toBe(true);
    expect(active?.connection.credentials).toEqual({ apiKey: "mf_active_9999" });
  });
});
