import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { runAsCompanyService } from "@/db/isolation/twoCompanies";
import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  seedContract,
  setCompanyClaimContext,
  withRollback,
} from "@/db/testDb";
import { JOB_CATALOG, type JobKind } from "@/jobs/catalog";

afterAll(closePool);

/**
 * Migration 308 — the money event outbox.
 *
 * Every money event of contracts/jobs.md section 5 leaves the database with the
 * transaction that made the change (FR-018): a rolled-back change leaves no
 * event, and a committed change never loses one. Real SQL against a real
 * Postgres built from db/migrations, called in the role each function really
 * has: staff through PostgREST (`authenticated`) and the gateway settlement
 * through the company client (`company_service`).
 */

/** معرّفات الكيانات التي يلمسها السيناريو. */
type Prepared = Record<string, string>;

interface MoneyScenario {
  kind: JobKind;
  /** يحضّر بيانات الاختبار ويعيد معرّفات الكيانات التي يلمسها الحدث. */
  prepare: (client: PoolClient, companyId: string) => Promise<Prepared>;
  /** ينفّذ تغيير المال الذي يجب أن يخرج معه الحدث ويعيد حمولة الحدث المتوقعة. */
  act: (client: PoolClient, companyId: string, prepared: Prepared) => Promise<Prepared>;
  /** ينفّذ الإجراء نفسه مرة أخرى؛ يجب ألّا يولد صفاً ثانياً. */
  repeat: (client: PoolClient, companyId: string, prepared: Prepared) => Promise<void>;
  /**
   * هل يرفض المالك الإجراء المكرر؟ التصفية والعكس والشطب والاسترداد ترفضه،
   * أما التوزيع والنزاع وتعديل مبلغ الإيداع فتقبله.
   */
  repeatIsRefused: boolean;
  /**
   * كم حدثاً يترك التكرار. كل الأحداث حدث واحد لأن مفتاح منع التكرار يفردها،
   * عدا نزاع الفاتورة: كل رفع للنزاع هو نزاع جديد، فيُصدر حدثه الخاص (GR-004).
   */
  eventsAfterRepeat: number;
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

/** ينشئ مدير الشركة ويتصرّف بصلاحية `authenticated` كما تفعل PostgREST. */
async function actAsAdmin(client: PoolClient, companyId: string): Promise<string> {
  const adminId = await seedCompanyUser(client, companyId, "admin", "outbox-admin");
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
  opts: { total: number; month?: number },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.invoices (
       company_id, contract_id, tenant_id, unit_id, period_year, period_month,
       issue_date, due_date, subtotal, discount, total, paid, state, idempotency_key
     ) values (
       $1, $2, $3, $4, 2026, $5, '2026-01-01', '2026-01-05', $6, 0, $6, 0, 'due', $7
     ) returning id`,
    [
      fx.companyId,
      fx.contractId,
      fx.tenantId,
      fx.unitId,
      opts.month ?? 1,
      opts.total,
      `inv-${randomUUID()}`,
    ],
  );
  return rows[0].id;
}

/** ينشئ دفعة مؤكّدة. */
async function seedPayment(
  client: PoolClient,
  opts: { companyId: string; tenantId: string; unitId: string; amount: number },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.payments (
       company_id, code, tenant_id, unit_id, method, amount, payment_date, status
     ) values ($1, $2, $3, $4, 'cash', $5, current_date, 'confirmed')
     returning id`,
    [opts.companyId, `PAY-${randomUUID()}`, opts.tenantId, opts.unitId, opts.amount],
  );
  return rows[0].id;
}

/** ينشئ تأميناً محتجزاً يجعل التصفية تستردّ مبلغاً. */
async function seedInsurance(
  client: PoolClient,
  opts: { companyId: string; contractId: string; tenantId: string; unitId: string; amount: number },
): Promise<void> {
  await client.query(
    `insert into public.insurance_payments
       (company_id, contract_id, tenant_id, unit_id, amount, collected_date)
     values ($1, $2, $3, $4, $5, current_date)`,
    [opts.companyId, opts.contractId, opts.tenantId, opts.unitId, opts.amount],
  );
}

/** ينشئ إيداعاً بنكيا بالحالة المطلوبة. */
async function seedDeposit(
  client: PoolClient,
  opts: { companyId: string; status: string },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.deposits (company_id, code, deposit_date, bank_name, amount, status)
     values ($1, $2, current_date, 'KIB', 100, $3)
     returning id`,
    [opts.companyId, `DEP-${randomUUID()}`, opts.status],
  );
  return rows[0].id;
}

/** ينفّذ تصفية عقد ويعيد نتيجتها. */
async function closeOut(
  client: PoolClient,
  contractId: string,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    `select public.close_out_contract(
       $1::uuid, current_date, 'archive', 'terminated', false,
       '[]'::jsonb, '[]'::jsonb, null, 'money outbox test',
       $2, null
     ) as result`,
    [contractId, idempotencyKey ?? `idem-${randomUUID()}`],
  );
  return rows[0].result;
}

/** يستعيد عقداً مؤرشفاً. */
async function restoreContract(client: PoolClient, contractId: string): Promise<void> {
  await client.query(
    `select public.restore_contract($1::uuid, 'active', false, 'tenant returned early')`,
    [contractId],
  );
}

/** صفٌّ في `job_requests` كما تراه لوحة المهام. */
interface JobRow {
  company_id: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: string;
  requested_by: string | null;
}

/** يقرأ صفوف `job_requests` من نوع معيّن بصلاحية المشرف العام. */
async function jobRows(client: PoolClient, companyId: string, kind: JobKind): Promise<JobRow[]> {
  await actAsSuperuser(client);
  const { rows } = await client.query<JobRow>(
    `select company_id, payload, dedupe_key, status, requested_by
       from public.job_requests where company_id = $1 and kind = $2`,
    [companyId, kind],
  );
  return rows;
}

/** يتحقق أن الحمولة تقرأ وفق مخطط الكتالوج الصارم (`.strict()`). */
function parsesAgainstCatalog(kind: JobKind, payload: unknown): boolean {
  const spec: { payload: { safeParse: (value: unknown) => { success: boolean } } } =
    JOB_CATALOG[kind];
  return spec.payload.safeParse(payload).success;
}

const scenarios: MoneyScenario[] = [
  {
    kind: "payment.succeeded",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      const firstInvoice = await seedInvoice(client, fx, { total: 100, month: 1 });
      const secondInvoice = await seedInvoice(client, fx, { total: 100, month: 2 });
      const paymentId = await seedPayment(client, {
        companyId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        amount: 200,
      });
      return { firstInvoice, secondInvoice, paymentId };
    },
    act: async (client, _companyId, prepared) => {
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        prepared.paymentId,
        JSON.stringify([{ invoice_id: prepared.firstInvoice, amount: 100 }]),
      ]);
      return { paymentId: prepared.paymentId };
    },
    repeat: async (client, _companyId, prepared) => {
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        prepared.paymentId,
        JSON.stringify([{ invoice_id: prepared.secondInvoice, amount: 100 }]),
      ]);
    },
    repeatIsRefused: false,
    eventsAfterRepeat: 1,
  },
  {
    kind: "payment.reversed",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      const paymentId = await seedPayment(client, {
        companyId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        amount: 300,
      });
      return { paymentId };
    },
    act: async (client, _companyId, prepared) => {
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [
        prepared.paymentId,
        "tenant cheque bounced",
      ]);
      return { paymentId: prepared.paymentId };
    },
    repeat: async (client, _companyId, prepared) => {
      await client.query(`select public.reverse_payment($1::uuid, $2)`, [
        prepared.paymentId,
        "reversed twice",
      ]);
    },
    repeatIsRefused: true,
    eventsAfterRepeat: 1,
  },
  {
    kind: "deposit.confirmed",
    prepare: async (client, companyId) => {
      await setCompanyClaimContext(client, companyId);
      const depositId = await seedDeposit(client, { companyId, status: "pending" });
      return { depositId };
    },
    act: async (client, _companyId, prepared) => {
      await client.query(`update public.deposits set status = 'confirmed' where id = $1`, [
        prepared.depositId,
      ]);
      return { depositId: prepared.depositId };
    },
    repeat: async (client, _companyId, prepared) => {
      await client.query(`update public.deposits set amount = amount + 1 where id = $1`, [
        prepared.depositId,
      ]);
    },
    repeatIsRefused: false,
    eventsAfterRepeat: 1,
  },
  {
    kind: "refund.recorded",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      await seedInsurance(client, {
        companyId,
        contractId: fx.contractId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        amount: 100,
      });
      return { contractId: fx.contractId };
    },
    act: async (client, _companyId, prepared) => {
      const result = await closeOut(client, prepared.contractId);
      return { refundId: String(result.refund_id) };
    },
    repeat: async (client, _companyId, prepared) => {
      await closeOut(client, prepared.contractId);
    },
    repeatIsRefused: true,
    eventsAfterRepeat: 1,
  },
  {
    kind: "invoice.written_off",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx, { total: 100 });
      return { invoiceId };
    },
    act: async (client, _companyId, prepared) => {
      await client.query(`select public.write_off_invoice($1::uuid, $2)`, [
        prepared.invoiceId,
        "unrecoverable",
      ]);
      return { invoiceId: prepared.invoiceId };
    },
    repeat: async (client, _companyId, prepared) => {
      await client.query(`select public.write_off_invoice($1::uuid, $2)`, [
        prepared.invoiceId,
        "written off twice",
      ]);
    },
    repeatIsRefused: true,
    eventsAfterRepeat: 1,
  },
  {
    kind: "invoice.disputed",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx, { total: 100 });
      return { invoiceId };
    },
    act: async (client, _companyId, prepared) => {
      await client.query(`select public.set_invoice_dispute($1::uuid, $2)`, [
        prepared.invoiceId,
        "tenant disputes the charge",
      ]);
      return { invoiceId: prepared.invoiceId };
    },
    repeat: async (client, _companyId, prepared) => {
      await client.query(`select public.set_invoice_dispute($1::uuid, $2)`, [
        prepared.invoiceId,
        "still disputed",
      ]);
    },
    repeatIsRefused: false,
    // A second dispute is a second dispute instance, not a duplicate of the
    // first: the dedupe key carries the dispute's own audit row (GR-004).
    eventsAfterRepeat: 2,
  },
  {
    kind: "contract.closed_out",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      return { contractId: fx.contractId, idempotencyKey: `idem-${randomUUID()}` };
    },
    act: async (client, _companyId, prepared) => {
      await closeOut(client, prepared.contractId, prepared.idempotencyKey);
      return { contractId: prepared.contractId };
    },
    repeat: async (client, _companyId, prepared) => {
      await closeOut(client, prepared.contractId, prepared.idempotencyKey);
    },
    repeatIsRefused: false,
    eventsAfterRepeat: 1,
  },
  {
    kind: "contract.restored",
    prepare: async (client, companyId) => {
      const fx = await seedBaseContract(client, companyId);
      return { contractId: fx.contractId };
    },
    act: async (client, _companyId, prepared) => {
      await closeOut(client, prepared.contractId);
      await restoreContract(client, prepared.contractId);
      return { contractId: prepared.contractId };
    },
    repeat: async (client, _companyId, prepared) => {
      await restoreContract(client, prepared.contractId);
    },
    repeatIsRefused: true,
    eventsAfterRepeat: 1,
  },
];

describe("the money event outbox (T071)", () => {
  test.each(scenarios)(
    "$kind leaves one job_requests row with the catalogue payload",
    async (scenario) => {
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        const prepared = await scenario.prepare(client, companyId);
        const adminId = await actAsAdmin(client, companyId);

        await client.query("savepoint money_change");
        const payload = await scenario.act(client, companyId, prepared);
        await client.query("release savepoint money_change");

        const rows = await jobRows(client, companyId, scenario.kind);
        expect(rows).toHaveLength(1);
        expect(rows[0].company_id).toBe(companyId);
        expect(rows[0].status).toBe("pending");
        expect(rows[0].payload).toEqual(payload);
        expect(rows[0].requested_by).toBe(adminId);
        expect(rows[0].dedupe_key).toContain(`${scenario.kind}:`);
        expect(rows[0].dedupe_key).toContain(Object.values(payload)[0]);
        expect(parsesAgainstCatalog(scenario.kind, rows[0].payload)).toBe(true);
      });
    },
  );

  test.each(scenarios)(
    "$kind leaves no row when the money change is rolled back",
    async (scenario) => {
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        const prepared = await scenario.prepare(client, companyId);
        await actAsAdmin(client, companyId);

        await client.query("savepoint money_change");
        await scenario.act(client, companyId, prepared);
        await client.query("rollback to savepoint money_change");

        expect(await jobRows(client, companyId, scenario.kind)).toHaveLength(0);
      });
    },
  );

  test.each(scenarios)(
    "$kind emits $eventsAfterRepeat event(s) when the same change happens twice",
    async (scenario) => {
      await withRollback(async (client) => {
        const companyId = await seedCompany(client);
        const prepared = await scenario.prepare(client, companyId);
        await actAsAdmin(client, companyId);

        await client.query("savepoint money_change");
        await scenario.act(client, companyId, prepared);
        await client.query("release savepoint money_change");
        // Most repeats are refused by the owning function itself (a second
        // reversal, a second write-off, a second close-out of the same
        // contract). The dispute and the allocation are allowed to happen
        // again — the dedupe key is what keeps them to one event.
        const refusal = await captureRaise(client, () =>
          scenario.repeat(client, companyId, prepared),
        );
        expect(refusal !== null).toBe(scenario.repeatIsRefused);

        expect(await jobRows(client, companyId, scenario.kind)).toHaveLength(
          scenario.eventsAfterRepeat,
        );
      });
    },
  );

  test("a company_service caller (the gateway settlement) emits the event too", async () => {
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx, { total: 100 });
      const paymentId = await seedPayment(client, {
        companyId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        amount: 100,
      });

      await runAsCompanyService(client, companyId, async () => {
        await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
          paymentId,
          JSON.stringify([{ invoice_id: invoiceId, amount: 100 }]),
        ]);
      });

      const rows = await jobRows(client, companyId, "payment.succeeded");
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ paymentId });
      // A company client carries no `sub`, so nobody is named as the requester.
      expect(rows[0].requested_by).toBeNull();
    });
  });

  test("a platform service_role settlement still moves money and files the event for that company", async () => {
    // GR-003: `enqueue_job` needs a company context and a service_role sweep
    // has none by design. The event must not be dropped: the money function
    // knows the company of the row it changed, and files the event there.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx, { total: 100 });
      const paymentId = await seedPayment(client, {
        companyId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        amount: 100,
      });

      await actAs(client, "service_role");
      await client.query(`select public.apply_payment_allocation($1::uuid, $2::jsonb)`, [
        paymentId,
        JSON.stringify([{ invoice_id: invoiceId, amount: 100 }]),
      ]);

      const invoice = await client.query<{ state: string }>(
        `select state from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(invoice.rows[0].state).toBe("paid");

      const rows = await jobRows(client, companyId, "payment.succeeded");
      expect(rows).toHaveLength(1);
      expect(rows[0].company_id).toBe(companyId);
      expect(rows[0].payload).toEqual({ paymentId });
      expect(rows[0].status).toBe("pending");
      // A platform sweep has no signed-in staff member to name.
      expect(rows[0].requested_by).toBeNull();
    });
  });

  test("a dispute that is cleared and raised again is a second event", async () => {
    // GR-004: the dedupe key names the dispute instance, so clearing the flag
    // and disputing again is a new event and not a swallowed one.
    await withRollback(async (client) => {
      const companyId = await seedCompany(client);
      const fx = await seedBaseContract(client, companyId);
      const invoiceId = await seedInvoice(client, fx, { total: 100 });
      await actAsAdmin(client, companyId);

      await client.query(`select public.set_invoice_dispute($1::uuid, $2)`, [
        invoiceId,
        "tenant disputes the charge",
      ]);
      await client.query(`select public.clear_invoice_dispute($1::uuid)`, [invoiceId]);
      await client.query(`select public.set_invoice_dispute($1::uuid, $2)`, [
        invoiceId,
        "the tenant disputes it again",
      ]);

      const rows = await jobRows(client, companyId, "invoice.disputed");
      expect(rows).toHaveLength(2);
      expect(rows[0].payload).toEqual({ invoiceId });
      expect(rows[1].payload).toEqual({ invoiceId });
      // Two dispute instances, two keys: the invoice id alone would have
      // swallowed the second one.
      expect(rows[0].dedupe_key).not.toBe(rows[1].dedupe_key);
      for (const row of rows) {
        expect(row.dedupe_key).toContain(invoiceId);
      }
    });
  });
});
