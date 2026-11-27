import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService, runAsUser, seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يدرج صف اتصال واتساب للشركة المحددة ويعيد معرّفه.
 */
async function seedWhatsappConnection(
  client: PoolClient,
  companyId: string,
  opts: {
    method?: "evolution_qr" | "cloud_api" | "cloud_coexistence";
    isActive?: boolean;
    status?: "disconnected" | "pairing" | "connected" | "error";
    connectedNumber?: string | null;
    phoneNumberId?: string | null;
  } = {},
): Promise<string> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.whatsapp_connections (
       company_id, method, is_active, status, connected_number, phone_number_id
     ) values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      companyId,
      opts.method ?? "evolution_qr",
      opts.isActive ?? false,
      opts.status ?? "disconnected",
      opts.connectedNumber ?? null,
      opts.phoneNumberId ?? null,
    ],
  );
  return rows[0].id;
}

/**
 * يدرج جهة اتصال واتساب وعقداً تجريبياً للشركة لاختبار المفتاح الأجنبي المركّب على جداول `whatsapp_*`.
 */
async function seedWhatsappPrerequisites(
  client: PoolClient,
  companyId: string,
  tag: string,
): Promise<{ contactId: string; contractId: string }> {
  await actAsSuperuser(client);
  const {
    rows: [tenant],
  } = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name, lifecycle)
     values ($1, $2, $3, 'active')
     returning id`,
    [`T-${tag}`, companyId, `مستأجر ${tag}`],
  );
  const {
    rows: [contract],
  } = await client.query<{ id: string }>(
    `insert into public.contracts (
       company_id, code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state
     ) values ($1, $2, $3, '2026-01-01', '2026-12-31', 1, 5, 0, 'active')
     returning id`,
    [companyId, `C-${tag}`, tenant.id],
  );
  const {
    rows: [contact],
  } = await client.query<{ id: string }>(
    `insert into public.whatsapp_contacts (company_id, phone, tenant_id)
     values ($1, $2, $3)
     returning id`,
    [companyId, `9655000${tag.slice(0, 4)}`, tenant.id],
  );
  return { contactId: contact.id, contractId: contract.id };
}

type WhatsappChildTable =
  | "whatsapp_chats"
  | "whatsapp_contacts"
  | "whatsapp_messages"
  | "whatsapp_contact_contracts";

interface WhatsappChildInsertParams {
  table: WhatsappChildTable;
  companyId: string;
  connectionId: string | null;
  tag: string;
  prereqs: { contactId: string; contractId: string };
}

/**
 * ينفّذ إدراجاً في أحد جداول `whatsapp_*` الأربعة بقيمة `connection_id` محددة (أو `null`).
 */
async function insertWhatsappChildRow(
  client: PoolClient,
  params: WhatsappChildInsertParams,
): Promise<string | null> {
  const { table, companyId, connectionId, tag, prereqs } = params;
  if (table === "whatsapp_chats") {
    return captureRaise(client, () =>
      client.query(
        `insert into public.whatsapp_chats (company_id, chat_number, connection_id)
         values ($1, $2, $3)`,
        [companyId, `9655111${tag.slice(0, 4)}`, connectionId],
      ),
    );
  }
  if (table === "whatsapp_contacts") {
    return captureRaise(client, () =>
      client.query(
        `insert into public.whatsapp_contacts (company_id, phone, connection_id)
         values ($1, $2, $3)`,
        [companyId, `9655222${tag.slice(0, 4)}`, connectionId],
      ),
    );
  }
  if (table === "whatsapp_messages") {
    return captureRaise(client, () =>
      client.query(
        `insert into public.whatsapp_messages (company_id, message_id, chat_number, direction, connection_id)
         values ($1, $2, $3, 'inbound', $4)`,
        [companyId, `msg-${tag}`, `9655333${tag.slice(0, 4)}`, connectionId],
      ),
    );
  }
  return captureRaise(client, () =>
    client.query(
      `insert into public.whatsapp_contact_contracts (company_id, contact_id, contract_id, connection_id)
       values ($1, $2, $3, $4)`,
      [companyId, prereqs.contactId, prereqs.contractId, connectionId],
    ),
  );
}

describe("migration 333 - whatsapp_connections isolation and constraints (T156)", () => {
  test("company allows one active method and refuses a second active method", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      await seedWhatsappConnection(client, A.id, {
        method: "evolution_qr",
        isActive: true,
        status: "connected",
        connectedNumber: "+96550001111",
      });

      const secondActiveErr = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () =>
          client.query(
            `insert into public.whatsapp_connections (company_id, method, is_active)
             values ($1, 'cloud_api', true)`,
            [A.id],
          ),
        ),
      );
      expect(secondActiveErr).not.toBeNull();

      // An inactive second method for the same company is permitted.
      const inactiveSecondErr = await runAsCompanyService(client, A.id, () =>
        captureRaise(client, () =>
          client.query(
            `insert into public.whatsapp_connections (company_id, method, is_active)
             values ($1, 'cloud_api', false)`,
            [A.id],
          ),
        ),
      );
      expect(inactiveSecondErr).toBeNull();
    });
  });

  test.each([
    {
      label: "identical normalized connected_number",
      numberA: "+96550002222",
      numberB: "965 5000-2222",
      phoneIdA: null,
      phoneIdB: null,
    },
    {
      label: "identical Meta phone_number_id",
      numberA: null,
      numberB: null,
      phoneIdA: "pnid_shared_123",
      phoneIdB: "pnid_shared_123",
    },
  ])(
    "active $label cannot be held by two companies at once, but can move after deactivation",
    async ({ numberA, numberB, phoneIdA, phoneIdB }) => {
      await withRollback(async (client) => {
        const { A, B } = await seedTwoCompanies(client);

        const connA = await seedWhatsappConnection(client, A.id, {
          method: numberA ? "evolution_qr" : "cloud_api",
          isActive: true,
          status: "connected",
          connectedNumber: numberA,
          phoneNumberId: phoneIdA,
        });

        const duplicateErr = await runAsCompanyService(client, B.id, () =>
          captureRaise(client, () =>
            client.query(
              `insert into public.whatsapp_connections (
                 company_id, method, is_active, status, connected_number, phone_number_id
               ) values ($1, $2, true, 'connected', $3, $4)`,
              [B.id, numberB ? "evolution_qr" : "cloud_api", numberB, phoneIdB],
            ),
          ),
        );
        expect(duplicateErr).not.toBeNull();

        // Once company A deactivates its connection, company B can claim the identifier.
        await runAsCompanyService(client, A.id, () =>
          client.query(
            `update public.whatsapp_connections set is_active = false, status = 'disconnected' where id = $1`,
            [connA],
          ),
        );

        const afterDeactivateErr = await runAsCompanyService(client, B.id, () =>
          captureRaise(client, () =>
            client.query(
              `insert into public.whatsapp_connections (
                 company_id, method, is_active, status, connected_number, phone_number_id
               ) values ($1, $2, true, 'connected', $3, $4)`,
              [B.id, numberB ? "evolution_qr" : "cloud_api", numberB, phoneIdB],
            ),
          ),
        );
        expect(afterDeactivateErr).toBeNull();
      });
    },
  );

  test("another company cannot read a connection via company_service or authenticated", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const connA = await seedWhatsappConnection(client, A.id, {
        method: "evolution_qr",
        isActive: true,
        status: "connected",
        connectedNumber: "+96550003333",
      });

      const serviceRows = await runAsCompanyService(client, B.id, async () => {
        const { rows } = await client.query(
          `select id from public.whatsapp_connections where id = $1`,
          [connA],
        );
        return rows;
      });
      expect(serviceRows).toHaveLength(0);

      const authRows = await runAsUser(client, B.users.admin, async () => {
        const { rows } = await client.query(
          `select id from public.whatsapp_connections where id = $1`,
          [connA],
        );
        return rows;
      });
      expect(authRows).toHaveLength(0);

      // Own-company admin with settings.integrations can read non-secret columns.
      const ownAuthRows = await runAsUser(client, A.users.admin, async () => {
        const { rows } = await client.query(
          `select id from public.whatsapp_connections where id = $1`,
          [connA],
        );
        return rows;
      });
      expect(ownAuthRows).toHaveLength(1);
    });
  });

  test.each<WhatsappChildTable>([
    "whatsapp_chats",
    "whatsapp_contacts",
    "whatsapp_messages",
    "whatsapp_contact_contracts",
  ])(
    "%s refuses cross-company connection_id and defaults null connection_id to the active connection",
    async (table) => {
      await withRollback(async (client) => {
        const { A, B } = await seedTwoCompanies(client);
        const tag = randomUUID().replace(/-/g, "").slice(0, 8);

        const connA = await seedWhatsappConnection(client, A.id, {
          method: "evolution_qr",
          isActive: true,
          status: "connected",
          connectedNumber: `+9655444${tag.slice(0, 4)}`,
        });
        const connB = await seedWhatsappConnection(client, B.id, {
          method: "evolution_qr",
          isActive: true,
          status: "connected",
          connectedNumber: `+9655555${tag.slice(0, 4)}`,
        });
        const prereqs = await seedWhatsappPrerequisites(client, A.id, tag);

        const crossFkErr = await runAsCompanyService(client, A.id, () =>
          insertWhatsappChildRow(client, {
            table,
            companyId: A.id,
            connectionId: connB,
            tag,
            prereqs,
          }),
        );
        expect(crossFkErr).not.toBeNull();

        // Omitting connection_id fills it from company A's active connection via trigger.
        const defaultErr = await runAsCompanyService(client, A.id, () =>
          insertWhatsappChildRow(client, {
            table,
            companyId: A.id,
            connectionId: null,
            tag: `${tag}d`,
            prereqs,
          }),
        );
        expect(defaultErr).toBeNull();

        await actAsSuperuser(client);
        const { rows } = await client.query<{ connection_id: string }>(
          `select connection_id from public.${table}
            where company_id = $1 and connection_id = $2`,
          [A.id, connA],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
      });
    },
  );
});
