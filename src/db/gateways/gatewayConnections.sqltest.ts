import { randomBytes, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  COMPANY_ROLES,
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
} from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يستخرج رمز SQLSTATE من كائن خطأ PostgreSQL إن وُجد.
 */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * ينشئ اتصال بوابة دفع لشركة محددة عبر دور `company_service` ويعيد معرّفه.
 */
async function insertGatewayConnection(
  client: PoolClient,
  companyId: string,
  provider: "myfatoorah" | "tap" | "upayments",
  opts?: { isActive?: boolean; lastTestOk?: boolean; lastTestAt?: string | null },
): Promise<string> {
  return runAsCompanyService(client, companyId, async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.gateway_connections
         (company_id, provider, is_active, last_test_ok, last_test_at)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        companyId,
        provider,
        opts?.isActive ?? false,
        opts?.lastTestOk ?? false,
        opts?.lastTestAt ?? null,
      ],
    );
    return rows[0].id;
  });
}

/**
 * يدرج سراً مشفّراً في `company_secrets` عبر `company_service` ويعيد معرّفه.
 */
async function insertCompanySecret(
  client: PoolClient,
  companyId: string,
  ownerId: string,
  name: string,
  last4 = "9876",
): Promise<string> {
  return runAsCompanyService(client, companyId, async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.company_secrets
         (company_id, owner_kind, owner_id, name, ciphertext, iv, auth_tag, key_version, last4)
       values ($1, 'gateway', $2, $3, $4, $5, $6, 1, $7)
       returning id`,
      [companyId, ownerId, name, randomBytes(24), randomBytes(12), randomBytes(16), last4],
    );
    return rows[0].id;
  });
}

describe("T136 gateway_connections & company_secrets SQL invariants", () => {
  test("a company can have at most one active gateway connection (FR-056)", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const now = new Date().toISOString();

      await insertGatewayConnection(client, A.id, "myfatoorah", {
        isActive: true,
        lastTestOk: true,
        lastTestAt: now,
      });

      // Another company activating the same provider must succeed independently.
      const bConnId = await insertGatewayConnection(client, B.id, "myfatoorah", {
        isActive: true,
        lastTestOk: true,
        lastTestAt: now,
      });
      expect(bConnId).toBeTruthy();

      // Activating a second provider in company A must fail with unique_violation.
      await runAsCompanyService(client, A.id, async () => {
        const err = await captureRaiseError(client, () =>
          client.query(
            `insert into public.gateway_connections
               (company_id, provider, is_active, last_test_ok, last_test_at)
             values ($1, 'tap', true, true, $2)`,
            [A.id, now],
          ),
        );
        expect(pgErrorCode(err)).toBe("23505");
      });
    });
  });

  test("activating a gateway connection without a recorded passing test fails (FR-055)", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const connId = await insertGatewayConnection(client, A.id, "myfatoorah");

      await runAsCompanyService(client, A.id, async () => {
        const err = await captureRaiseError(client, () =>
          client.query(`update public.gateway_connections set is_active = true where id = $1`, [
            connId,
          ]),
        );
        expect(pgErrorCode(err)).toBe("23514");
      });
    });
  });

  test("rotating credentials_version invalidates prior test state and deactivates the connection", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const now = new Date().toISOString();
      const connId = await insertGatewayConnection(client, A.id, "myfatoorah", {
        isActive: true,
        lastTestOk: true,
        lastTestAt: now,
      });

      await runAsCompanyService(client, A.id, async () => {
        await client.query(
          `update public.gateway_connections
              set credentials_version = credentials_version + 1
            where id = $1`,
          [connId],
        );
      });

      await actAsSuperuser(client);
      const { rows } = await client.query<{
        is_active: boolean;
        last_test_ok: boolean;
        last_test_at: string | null;
      }>(
        `select is_active, last_test_ok, last_test_at
           from public.gateway_connections
          where id = $1`,
        [connId],
      );
      expect(rows).toEqual([{ is_active: false, last_test_ok: false, last_test_at: null }]);
    });
  });

  test.each(COMPANY_ROLES)(
    "authenticated %s cannot read company_secrets directly",
    async (role) => {
      await withRollback(async (client) => {
        const { A } = await seedTwoCompanies(client);
        const connId = await insertGatewayConnection(client, A.id, "myfatoorah");
        const secretId = await insertCompanySecret(client, A.id, connId, "api_key");

        await runAsUser(client, A.users[role], async () => {
          const err = await captureRaiseError(client, () =>
            client.query(`select last4 from public.company_secrets where id = $1`, [secretId]),
          );
          expect(pgErrorCode(err)).toBe("42501");
        });
      });
    },
  );

  test("company_secret_previews exposes only last4 to owning staff with settings.integrations", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const connId = await insertGatewayConnection(client, A.id, "myfatoorah");
      const secretId = await insertCompanySecret(client, A.id, connId, "api_key", "4321");

      await runAsUser(client, A.users.admin, async () => {
        const { rows } = await client.query<{ id: string; last4: string }>(
          `select id, last4 from public.company_secret_previews where id = $1`,
          [secretId],
        );
        expect(rows).toEqual([{ id: secretId, last4: "4321" }]);
      });

      await runAsUser(client, A.users.tenant, async () => {
        const { rows } = await client.query(
          `select id from public.company_secret_previews where id = $1`,
          [secretId],
        );
        expect(rows).toEqual([]);
      });

      await runAsUser(client, B.users.admin, async () => {
        const { rows } = await client.query(
          `select id from public.company_secret_previews where id = $1`,
          [secretId],
        );
        expect(rows).toEqual([]);
      });
    });
  });

  test("company_secrets are isolated across companies for company_service", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const connId = await insertGatewayConnection(client, A.id, "myfatoorah");
      const secretId = await insertCompanySecret(client, A.id, connId, "api_key");

      await runAsCompanyService(client, B.id, async () => {
        const { rowCount: seen } = await client.query(
          `select 1 from public.company_secrets where id = $1`,
          [secretId],
        );
        expect(seen).toBe(0);

        const { rowCount: updated } = await client.query(
          `update public.company_secrets set last4 = '0000' where id = $1`,
          [secretId],
        );
        expect(updated).toBe(0);

        const { rowCount: deleted } = await client.query(
          `delete from public.company_secrets where id = $1`,
          [secretId],
        );
        expect(deleted).toBe(0);
      });
    });
  });

  test("cross-company gateway_connection_id on payment_requests and webhook_events is rejected", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const bConnId = await insertGatewayConnection(client, B.id, "myfatoorah");
      const tenantAId = A.users.tenant.tenantId;
      expect(tenantAId).toBeTruthy();

      await runAsCompanyService(client, A.id, async () => {
        const prErr = await captureRaiseError(client, () =>
          client.query(
            `insert into public.payment_requests
               (company_id, tenant_id, amount, requested_invoice_ids, gateway_connection_id, credentials_version)
             values ($1, $2, 100.000, array[$3::uuid], $4, 1)`,
            [A.id, tenantAId, randomUUID(), bConnId],
          ),
        );
        expect(pgErrorCode(prErr)).toBe("23503");

        const weErr = await captureRaiseError(client, () =>
          client.query(
            `insert into public.webhook_events
               (company_id, gateway, provider, connection_id, provider_event_id)
             values ($1, 'myfatoorah', 'myfatoorah', $2, 'evt-cross')`,
            [A.id, bConnId],
          ),
        );
        expect(pgErrorCode(weErr)).toBe("23503");
      });
    });
  });

  test("webhook_events rejects duplicate (provider, connection_id, provider_event_id) for replay protection", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);
      const connId = await insertGatewayConnection(client, A.id, "myfatoorah");

      await runAsCompanyService(client, A.id, async () => {
        await client.query(
          `insert into public.webhook_events
             (company_id, gateway, provider, connection_id, provider_event_id)
           values ($1, 'myfatoorah', 'myfatoorah', $2, 'evt-1')`,
          [A.id, connId],
        );

        const dupErr = await captureRaiseError(client, () =>
          client.query(
            `insert into public.webhook_events
               (company_id, gateway, provider, connection_id, provider_event_id)
             values ($1, 'myfatoorah', 'myfatoorah', $2, 'evt-1')`,
            [A.id, connId],
          ),
        );
        expect(pgErrorCode(dupErr)).toBe("23505");
      });
    });
  });
});
