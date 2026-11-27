import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";
import { JOB_CATALOG, type JobKind } from "@/jobs/catalog";

afterAll(closePool);

/**
 * Migration 313 — معرّفات صفوف الأحداث داخل حمولات أحداث المال (GR-005).
 *
 * Each money function enqueues its event in the same transaction that wrote
 * the change, and the payload must name the row that event created — the
 * close-out row for `contract.closed_out`, the operational-event row for
 * `contract.restored` and `invoice.written_off`. Real SQL against a real
 * Postgres built from db/migrations: the test reads back the row each call
 * wrote (through the note or idempotency key that call itself supplied) and
 * demands the payload carries exactly that id — not whatever row a
 * latest-lookup would find.
 */

/** معرّفات الكيانات التي يلمسها السيناريو. */
interface Prepared extends Record<string, string> {
  entityId: string;
}

/** سيناريو حدث واحد: تحضير، ثم التغيير الذي يخرج معه الحدث، ثم قراءة الصف المكتوب. */
interface PayloadScenario {
  kind: JobKind;
  expectation: string;
  /** اسم حقل المعرّف في الحمولة إلى جانب معرّف الصف. */
  entityField: "invoiceId" | "contractId";
  prepare: (client: PoolClient, companyId: string) => Promise<Prepared>;
  act: (client: PoolClient, prepared: Prepared) => Promise<void>;
  /** يقرأ معرّف الصف الذي كتبه النداء، بالحقل الطبيعي الذي كتبه النداء نفسه. */
  writtenRowId: (client: PoolClient, prepared: Prepared) => Promise<string>;
}

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ مدير الشركة ويتصرّف بصلاحية `authenticated` كما تفعل PostgREST، ويعيد معرّفه. */
async function actAsAdmin(client: PoolClient, companyId: string): Promise<string> {
  const adminId = await seedCompanyUser(client, companyId, "admin", "payload-ids-admin");
  await actAs(client, "authenticated", adminId);
  return adminId;
}

/** ينشئ عقداً بوحدة واحدة ومستأجر واحد. */
async function seedBaseContract(client: PoolClient, companyId: string) {
  return seedContract(client, {
    companyId,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  });
}

/** ينشئ فاتورة مفتوحة على العقد. */
async function seedInvoice(
  client: PoolClient,
  fx: { companyId: string; contractId: string; tenantId: string; unitId: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       company_id, contract_id, tenant_id, unit_id, period_year, period_month,
       issue_date, due_date, subtotal, discount, total, paid, state, idempotency_key
     ) values (
       $1, $2, $3, $4, 2026, 1, '2026-01-01', '2026-01-05', 100, 0, 100, 0, 'due', $5
     ) returning id`,
    [fx.companyId, fx.contractId, fx.tenantId, fx.unitId, `inv-${randomUUID()}`],
  );
  return rows[0].id;
}

/** ينفّذ تصفية عقد بمفتاح تكرار معطى. */
async function closeOut(
  client: PoolClient,
  contractId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query(
    `select public.close_out_contract(
       $1::uuid, current_date, 'archive', 'terminated', false,
       '[]'::jsonb, '[]'::jsonb, null, 'payload ids test',
       $2, null
     )`,
    [contractId, idempotencyKey],
  );
}

/** يستعيد عقداً مؤرشفاً بالسبب المعيّن الذي يحمله صف الحدث. */
async function restoreContract(client: PoolClient, contractId: string): Promise<void> {
  await client.query(
    `select public.restore_contract($1::uuid, 'active', false, 'tenant returned early')`,
    [contractId],
  );
}

/** صفٌّ في `job_requests` كما تراه لوحة المهام. */
interface JobRow {
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: string;
}

/** يقرأ صفوف `job_requests` من نوع معيّن بصلاحية المشرف العام. */
async function jobRows(client: PoolClient, companyId: string, kind: JobKind): Promise<JobRow[]> {
  await actAsSuperuser(client);
  const { rows } = await client.query<JobRow>(
    `select payload, dedupe_key, status
       from public.job_requests where company_id = $1 and kind = $2`,
    [companyId, kind],
  );
  return rows;
}

/** يقرأ معرّف الإغلاق بالمفتاح الذي كتبه النداء نفسه. */
async function closeoutIdFor(client: PoolClient, idempotencyKey: string): Promise<string> {
  await actAsSuperuser(client);
  const { rows } = await client.query<{ id: string }>(
    `select id from public.contract_closeouts where idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0].id;
}

const scenarios: PayloadScenario[] = [
  {
    kind: "invoice.written_off",
    expectation: "carries the id of the write-off operational event it wrote",
    entityField: "invoiceId",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx);
      return { entityId: invoiceId };
    },
    act: async (client, prepared) => {
      await client.query(`select public.write_off_invoice($1::uuid, $2)`, [
        prepared.entityId,
        "unrecoverable",
      ]);
    },
    writtenRowId: async (client, prepared) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.contract_operational_events
          where event_type = 'invoice_written_off' and payload->>'invoice_id' = $1`,
        [prepared.entityId],
      );
      return rows[0].id;
    },
  },
  {
    kind: "contract.closed_out",
    expectation: "carries the id of the close-out row it wrote",
    entityField: "contractId",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      return { entityId: fx.contractId, idempotencyKey: `idem-${randomUUID()}` };
    },
    act: async (client, prepared) => {
      await closeOut(client, prepared.entityId, prepared.idempotencyKey);
    },
    writtenRowId: (client, prepared) => closeoutIdFor(client, prepared.idempotencyKey),
  },
  {
    kind: "contract.restored",
    expectation: "carries the id of the restore operational event it wrote",
    entityField: "contractId",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      return { entityId: fx.contractId, idempotencyKey: `idem-${randomUUID()}` };
    },
    act: async (client, prepared) => {
      await closeOut(client, prepared.entityId, prepared.idempotencyKey);
      await restoreContract(client, prepared.entityId);
    },
    writtenRowId: async (client, prepared) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ id: string }>(
        `select id from public.contract_operational_events
          where contract_id = $1 and event_type = 'restored'`,
        [prepared.entityId],
      );
      return rows[0].id;
    },
  },
];

describe("money event payloads name the row their call wrote (GR-005)", () => {
  test.each(scenarios)("$kind $expectation", async (scenario) => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const prepared = await scenario.prepare(client, companyId);
      await actAsAdmin(client, companyId);

      await scenario.act(client, prepared);

      const writtenRowId = await scenario.writtenRowId(client, prepared);
      const expected = {
        [scenario.entityField]: prepared.entityId,
        [scenario.kind === "contract.closed_out" ? "closeoutId" : "operationalEventId"]:
          writtenRowId,
      };
      const rows = await jobRows(client, companyId, scenario.kind);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      // الحمولة تحمل معرّف الصف الذي كتبه هذا النداء — بالضبط، لا أكثر ولا أقل.
      expect(rows[0].payload).toEqual(expected);
      expect(JOB_CATALOG[scenario.kind].payload.safeParse(rows[0].payload).success).toBe(true);
    });
  });

  test("a close → restore → close sequence names each close-out in its own event", async () => {
    // الحدثان يحملان معرّفين مختلفين: الأول معرّف إغلاقه هو، لا معرّف الإغلاق
    // الأحدث — وهذا بالضبط ما كان يفقده الحدث المتأخر قبل 313. قراءات الجداول
    // تتم بالمشرف العام، فكل عودة إلى الدوال تستعيد سياق المدير أولاً.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const fx = await seedBaseContract(client, companyId);
      const firstKey = `idem-${randomUUID()}`;
      const secondKey = `idem-${randomUUID()}`;
      const adminId = await actAsAdmin(client, companyId);

      await closeOut(client, fx.contractId, firstKey);
      const firstCloseoutId = await closeoutIdFor(client, firstKey);
      const afterFirst = await jobRows(client, companyId, "contract.closed_out");
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].payload).toEqual({
        contractId: fx.contractId,
        closeoutId: firstCloseoutId,
      });

      await actAs(client, "authenticated", adminId);
      await restoreContract(client, fx.contractId);
      await closeOut(client, fx.contractId, secondKey);
      const secondCloseoutId = await closeoutIdFor(client, secondKey);
      expect(secondCloseoutId).not.toBe(firstCloseoutId);

      const afterSecond = await jobRows(client, companyId, "contract.closed_out");
      expect(afterSecond).toHaveLength(2);
      expect(afterSecond.map((row) => row.payload.closeoutId).sort()).toEqual(
        [firstCloseoutId, secondCloseoutId].sort(),
      );
    });
  });
});
