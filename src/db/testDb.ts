import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

/**
 * Connection + fixture helpers for the SQL integration suite.
 *
 * These tests run real SQL against a real Postgres built from db/migrations —
 * the mock-based suites in src/fns/*.test.ts assert RPC *argument shapes* and
 * cannot observe what the SQL actually does.
 *
 * Connection URL mirrors scripts/test-db.sh, which owns the container.
 */
export function testDbUrl(): string {
  const port = process.env.TEST_DB_PORT ?? "54329";
  return process.env.TEST_DB_URL ?? `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  pool ??= new Pool({ connectionString: testDbUrl(), max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

/**
 * Runs `fn` inside a transaction that is ALWAYS rolled back.
 *
 * This is what keeps the suite order-independent without paying to rebuild the
 * database between tests. Note the database is not empty at rest —
 * 11_mock_data.sql and 15_mock_kuwait_data.sql seed demo rows — so assertions
 * must be scoped to the fixtures the test itself created rather than to global
 * counts.
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/**
 * Runs statements as a Supabase end user rather than the superuser.
 *
 * Connecting as `postgres` bypasses RLS, which is what you want when testing a
 * function's logic and precisely what you must avoid when testing a policy.
 *
 * Two claim GUCs are set, and both are load-bearing. Supabase has shipped two
 * shapes over the years: the flattened `request.jwt.claim.<name>` and the JSON
 * blob `request.jwt.claims`. The test image (supabase/postgres:15.1.1.78)
 * defines `auth.uid()` as `current_setting('request.jwt.claim.sub')`; newer
 * releases — including the 17.x running in production — read the JSON form.
 *
 * Setting only the JSON form left `auth.uid()` returning NULL here, which made
 * every identity look anonymous. That is a silent false pass, not a failure:
 * a test asserting "this user cannot see X" succeeds for the wrong reason, and
 * a policy that should have granted access looks like it correctly denied it.
 * `rls.sqltest.ts` asserts `auth.uid()` is actually populated for this reason.
 *
 * Local to the surrounding transaction, so withRollback undoes it.
 */
export async function actAs(
  client: PoolClient,
  role: "authenticated" | "anon" | "service_role",
  userId?: string,
): Promise<void> {
  const claims = JSON.stringify({ sub: userId ?? null, role });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
  await client.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
  await client.query("select set_config('role', $1, true)", [role]);
}

/**
 * Restores the pool's own role after actAs().
 *
 * Uses set_config(..., true) rather than RESET ROLE: RESET is session-scoped
 * and would outlive the surrounding transaction on a pooled connection.
 * Verified in rls.sqltest.ts — `postgres` is not superuser in this image, but
 * it owns the tables and FORCE ROW LEVEL SECURITY is off, so it bypasses RLS.
 */
export async function actAsSuperuser(client: PoolClient): Promise<void> {
  await client.query("select set_config('request.jwt.claims', '', true)");
  await client.query("select set_config('request.jwt.claim.sub', '', true)");
  await client.query("select set_config('request.jwt.claim.role', '', true)");
  await client.query("select set_config('role', 'postgres', true)");
}

/**
 * يضبط سياق الشركة في ادعاءات JWT المؤقتة عند العمل بصلاحية `postgres` حتى تعمل الدوال المعتمدة على `current_company_id()`.
 */
export async function setCompanyClaimContext(client: PoolClient, companyId: string): Promise<void> {
  const {
    rows: [{ role }],
  } = await client.query<{ role: string | null }>(
    `select nullif(current_setting('role', true), '') as role`,
  );
  if (!role || role === "none" || role === "postgres") {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: "company_service", company_id: companyId }),
    ]);
  }
}

/**
 * ينشئ مستخدماً في `auth.users` مع صف `profiles` ودور في `user_roles` ضمن الشركة المحددة.
 */
export async function seedCompanyUser(
  client: PoolClient,
  companyId: string,
  role: string,
  emailPrefix = "user",
): Promise<string> {
  const userId = randomUUID();
  const email = `${emailPrefix}-${userId.slice(0, 8)}@example.test`;
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [userId, email],
  );
  await client.query(
    `insert into public.profiles (id, company_id, display_name, is_active)
     values ($1, $2, $3, true)
     on conflict (id) do update set company_id = excluded.company_id, is_active = true`,
    [userId, companyId, `${role} ${userId.slice(0, 8)}`],
  );
  await client.query(
    `insert into public.user_roles (user_id, company_id, role)
     values ($1, $2, $3::public.app_role)`,
    [userId, companyId, role],
  );
  await client.query(
    `insert into public.role_permissions (company_id, role, permission_code)
     select distinct $1::uuid, $2::public.app_role, rp.permission_code
       from public.role_permissions rp
      where rp.role = $2::public.app_role
     on conflict (company_id, role, permission_code) do nothing`,
    [companyId, role],
  );
  return userId;
}

/**
 * Run `run` inside a SAVEPOINT and return the error message it raised, or null if it
 * succeeded.
 *
 * Postgres aborts the entire transaction on any error, so a bare
 * `expect(...).rejects.toThrow()` inside withRollback leaves the transaction unusable and
 * every later statement — including actAsSuperuser teardown — fails with
 * "current transaction is aborted". The savepoint confines the abort.
 */
export async function captureRaise(
  client: PoolClient,
  run: () => Promise<unknown>,
): Promise<string | null> {
  await client.query("savepoint __expect_raise");
  try {
    await run();
    await client.query("release savepoint __expect_raise");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint __expect_raise");
    await client.query("release savepoint __expect_raise");
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Same savepoint discipline as `captureRaise`, but returns the error OBJECT so
 * a caller can assert on `code` (the SQLSTATE) rather than on message text.
 *
 * Separate function rather than a widened `captureRaise` return type: ~30
 * callers already destructure the string, and an assertion on SQLSTATE is
 * strictly stronger than one on a message that translations or wording changes
 * can move.
 */
export async function captureRaiseError(
  client: PoolClient,
  run: () => Promise<unknown>,
): Promise<unknown> {
  await client.query("savepoint __expect_raise_error");
  try {
    await run();
    await client.query("release savepoint __expect_raise_error");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint __expect_raise_error");
    await client.query("release savepoint __expect_raise_error");
    return error;
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

export interface ContractFixture {
  companyId: string;
  propertyId: string;
  unitId: string;
  unitIds: string[];
  tenantId: string;
  contractId: string;
}

interface ContractOptions {
  /** Reuse an existing company instead of creating a new one (for same-company multi-contract fixtures). */
  companyId?: string;
  startDate: string;
  endDate: string;
  /** Defaults to 'active' — the only state generate_invoices acts on. */
  state?: string;
  monthlyAmount?: number;
  dueDay?: number;
  graceDays?: number;
  deposit?: number;
  lifecycle?: string;
  /**
   * Extra units to attach via contract_units (migration 110), each on its own
   * property-less extra unit under the same property. Omit for the default
   * single-unit shape every existing sqltest file relies on.
   */
  units?: Array<{ monthlyAmount: number }>;
}

/**
 * Creates company → property → unit → tenant → contract in one call.
 *
 * Codes are suffixed with a uuid fragment because properties/units/tenants all
 * carry unique `code` columns and the seeded demo data already occupies the
 * obvious values.
 */
export async function seedContract(
  client: PoolClient,
  options: ContractOptions,
): Promise<ContractFixture> {
  const {
    startDate,
    endDate,
    state = "active",
    monthlyAmount = 500,
    dueDay = 1,
    graceDays = 0,
    deposit = 0,
    lifecycle = "active",
  } = options;
  const tag = randomUUID().slice(0, 8);

  let companyId = options.companyId;
  if (!companyId) {
    const company = await client.query<{ id: string }>(
      `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
      [`شركة اختبار ${tag}`, `Test Co ${tag}`],
    );
    companyId = company.rows[0].id;
  }
  await setCompanyClaimContext(client, companyId);

  const property = await client.query<{ id: string }>(
    `insert into public.properties (code, company_id, name_ar, name_en)
     values ($1, $2, $3, $4) returning id`,
    [`P-${tag}`, companyId, `عقار ${tag}`, `Property ${tag}`],
  );
  const propertyId = property.rows[0].id;

  const unit = await client.query<{ id: string }>(
    `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
    [companyId, `U-${tag}`, propertyId, `Unit ${tag}`],
  );
  const unitId = unit.rows[0].id;

  const tenant = await client.query<{ id: string }>(
    `insert into public.tenants (code, company_id, name, lifecycle)
     values ($1, $2, $3, $4::public.tenant_lifecycle) returning id`,
    [`T-${tag}`, companyId, `مستأجر ${tag}`, lifecycle],
  );
  const tenantId = tenant.rows[0].id;

  // contracts carries company_id with composite FKs to tenants and units.
  //
  // unit_id is NOT written here: the column is dropped entirely in migration
  // 118. contract_units (migration 110) is the sole source of truth for which
  // units a contract holds — inserted just below.
  //
  // monthly_amount is NOT written here: it is the trigger-maintained total of
  // contract_units (migration 110). Writing it would be silently overwritten.
  const contract = await client.query<{ id: string }>(
    `insert into public.contracts
       (company_id, code, tenant_id, start_date, end_date, due_day, grace_days, deposit, state)
     values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9::public.contract_states)
     returning id`,
    [companyId, `C-${tag}`, tenantId, startDate, endDate, dueDay, graceDays, deposit, state],
  );
  const contractId = contract.rows[0].id;

  // Default shape is the single unit created above, so the ~30 existing
  // sqltest files keep their current call signature unchanged.
  const unitPlan = options.units ?? [{ monthlyAmount }];
  const unitIds: string[] = [unitId];
  for (let index = 1; index < unitPlan.length; index += 1) {
    const extra = await client.query<{ id: string }>(
      `insert into public.units (company_id, code, property_id, name) values ($1, $2, $3, $4) returning id`,
      [companyId, `U-${tag}-${index}`, propertyId, `Unit ${tag}-${index}`],
    );
    unitIds.push(extra.rows[0].id);
  }
  for (const [index, unitRow] of unitPlan.entries()) {
    await client.query(
      `insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
       values ($1, $2, $3, $4, $5)`,
      [companyId, contractId, unitIds[index], unitRow.monthlyAmount, index + 1],
    );
  }

  await setCompanyClaimContext(client, companyId);
  return { companyId, propertyId, unitId, unitIds, tenantId, contractId };
}

/** Billing periods currently invoiced for a contract, chronologically. */
export async function invoicePeriods(
  client: PoolClient,
  contractId: string,
): Promise<Array<{ year: number; month: number; total: string; paid: string; state: string }>> {
  const result = await client.query(
    `select period_year as year, period_month as month, total, paid, state
       from public.invoices where contract_id = $1
      order by period_year, period_month`,
    [contractId],
  );
  return result.rows;
}
