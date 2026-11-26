import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { buildScopedInsert, seedCompanyGraph } from "@/db/isolation/seedCompanyGraph";
import { seedTwoCompanies } from "@/db/isolation/twoCompanies";
import { captureRaiseError, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

/**
 * يستخرج رمز خطأ PostgreSQL للتحقق من انتهاك المفاتيح الأجنبية (23503) أو التفرد (23505).
 */
function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * يتحقق من أن القيمة الفريدة تتكرر بأمان بين الشركتين A و B ولكنها تُرفض عند التكرار داخل الشركة A.
 */
async function assertPerCompanyUnique(
  client: PoolClient,
  table: string,
  insertForCompany: (companyId: string, suffix: string) => Promise<void>,
  companyAId: string,
  companyBId: string,
): Promise<string | null> {
  const errA = await captureRaiseError(client, () => insertForCompany(companyAId, "1"));
  if (errA !== null) {
    return `${table}: initial insert for company A failed (${pgErrorCode(errA)}: ${String(errA)})`;
  }

  const errB = await captureRaiseError(client, () => insertForCompany(companyBId, "2"));
  if (errB !== null) {
    return `${table}: same key in company B was rejected (${pgErrorCode(errB)}: ${String(errB)})`;
  }

  const errDupA = await captureRaiseError(client, () => insertForCompany(companyAId, "3"));
  if (pgErrorCode(errDupA) !== "23505") {
    return `${table}: duplicate key inside company A expected 23505, got ${pgErrorCode(errDupA) ?? "no error"}`;
  }

  return null;
}

describe("T016 cross-company foreign keys and per-company uniques", () => {
  test("rejects every child row in company A that references a parent row in company B (FR-005)", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      const graphB = await seedCompanyGraph(client, B);
      const colMap = graphA.colMap;
      const tag = randomUUID().slice(0, 8);

      // Pending payment in B has no auto-generated receipt, so `receipts_payment_id_key`
      // does not fire before the cross-company foreign key check.
      const pendingPayB = buildScopedInsert(
        colMap,
        "payments",
        B.id,
        {
          company_id: B.id,
          code: `PAY-PEND-${tag}`,
          tenant_id: graphB.ids.tenantId,
          method: "cash",
          status: "pending",
          amount: 10,
          payment_date: "2026-02-01",
        },
        { method: "public.payment_methods" },
      );
      const {
        rows: [pendingPayBRow],
      } = await client.query<{ id: string }>(`${pendingPayB.sql} returning id`, pendingPayB.params);

      // Unoccupied unit in B avoids `one_active_contract_per_unit` before the FK check.
      const freeUnitB = buildScopedInsert(colMap, "units", B.id, {
        company_id: B.id,
        code: `U-FREE-${tag}`,
        property_id: graphB.ids.propertyId,
        name: "Free Unit B",
      });
      const {
        rows: [freeUnitBRow],
      } = await client.query<{ id: string }>(`${freeUnitB.sql} returning id`, freeUnitB.params);

      const cases: Array<{
        name: string;
        table: string;
        values: Record<string, unknown>;
        casts?: Record<string, string>;
      }> = [
        {
          name: "buildings.property_id -> B.property",
          table: "buildings",
          values: { code: `B-fk-${tag}`, property_id: graphB.ids.propertyId, name_ar: "Cross" },
        },
        {
          name: "units.property_id -> B.property",
          table: "units",
          values: { code: `U-fk1-${tag}`, property_id: graphB.ids.propertyId, name: "Cross" },
        },
        {
          name: "units.building_id -> B.building",
          table: "units",
          values: {
            code: `U-fk2-${tag}`,
            property_id: graphA.ids.propertyId,
            building_id: graphB.ids.buildingId,
            name: "Cross",
          },
        },
        {
          name: "contracts.tenant_id -> B.tenant",
          table: "contracts",
          values: {
            code: `C-fk-${tag}`,
            tenant_id: graphB.ids.tenantId,
            start_date: "2026-01-01",
            end_date: "2026-12-31",
          },
        },
        {
          name: "contract_units.unit_id -> B.unit",
          table: "contract_units",
          values: {
            contract_id: graphA.ids.contractId,
            unit_id: freeUnitBRow.id,
            monthly_amount: 100,
          },
        },
        {
          name: "invoices.contract_id -> B.contract",
          table: "invoices",
          values: {
            code: `INV-fk-${tag}`,
            contract_id: graphB.ids.contractId,
            tenant_id: graphA.ids.tenantId,
            period_year: 2027,
            period_month: 3,
            issue_date: "2027-03-01",
            due_date: "2027-03-05",
            idempotency_key: `inv-fk-${tag}`,
          },
        },
        {
          name: "invoice_items.invoice_id -> B.invoice",
          table: "invoice_items",
          values: {
            invoice_id: graphB.ids.invoiceId,
            line: 50,
            quantity: 1,
            unit_price: 10,
            amount: 10,
          },
        },
        {
          name: "payments.tenant_id -> B.tenant",
          table: "payments",
          values: {
            code: `PAY-fk-${tag}`,
            tenant_id: graphB.ids.tenantId,
            method: "cash",
            amount: 10,
            payment_date: "2026-02-01",
          },
          casts: { method: "public.payment_methods" },
        },
        {
          name: "payment_allocations.invoice_id -> B.invoice",
          table: "payment_allocations",
          values: {
            payment_id: graphA.ids.paymentId,
            invoice_id: graphB.ids.invoiceId,
            amount: 10,
          },
        },
        {
          name: "receipts.payment_id -> B.payment",
          table: "receipts",
          values: {
            code: `RCP-fk-${tag}`,
            payment_id: pendingPayBRow.id,
            tenant_id: graphA.ids.tenantId,
            amount: 10,
          },
        },
        {
          name: "deposits.contract_id/invoice_id -> B",
          table: "deposits",
          values: {
            code: `DEP-fk-${tag}`,
            deposit_date: "2026-02-01",
            bank_name: "NBK",
            amount: 10,
            contract_id: graphB.ids.contractId,
            invoice_id: graphB.ids.invoiceId,
          },
        },
        {
          name: "refunds.contract_id -> B.contract",
          table: "refunds",
          values: {
            code: `REF-fk-${tag}`,
            contract_id: graphB.ids.contractId,
            tenant_id: graphA.ids.tenantId,
            amount: 10,
          },
        },
        {
          name: "maintenance_requests.property_id -> B.property",
          table: "maintenance_requests",
          values: { code: `M-fk-${tag}`, property_id: graphB.ids.propertyId, title: "Cross" },
        },
        {
          name: "electricity_meters.unit_id -> B.unit",
          table: "electricity_meters",
          values: { unit_id: graphB.ids.unitId, tariff_id: graphA.ids.tariffId, is_active: false },
        },
        {
          name: "meter_readings.meter_id -> B.meter",
          table: "meter_readings",
          values: {
            meter_id: graphB.ids.meterId,
            reading: 250,
            consumption_kwh: 150,
            reading_date: "2026-03-01",
            period_year: 2026,
            period_month: 3,
          },
        },
        {
          name: "salaries.employee_id -> B.employee",
          table: "salaries",
          values: { employee_id: graphB.ids.employeeId, year: 2026, month: 3, amount: 100 },
        },
        {
          name: "user_tenants.tenant_id -> B.tenant",
          table: "user_tenants",
          values: { user_id: A.users.admin.id, tenant_id: graphB.ids.tenantId },
        },
        {
          name: "tenant_documents.tenant_id -> B.tenant",
          table: "tenant_documents",
          values: {
            tenant_id: graphB.ids.tenantId,
            type: "other",
            storage_path: `companies/${A.id}/tenants/fk-${tag}.pdf`,
          },
          casts: { type: "public.tenant_document_types" },
        },
        {
          name: "option_list_items.list_id -> B.option_list",
          table: "option_list_items",
          values: {
            list_id: graphB.ids.optionListId,
            value: `v-${tag}`,
            label_ar: "x",
            label_en: "x",
          },
        },
        {
          name: "custom_role_permissions.custom_role_id -> B.custom_role",
          table: "custom_role_permissions",
          values: { custom_role_id: graphB.ids.customRoleId, permission_code: "audit.create" },
        },
      ];

      const unguarded: string[] = [];
      for (const c of cases) {
        if (!colMap.get(c.table)?.has("company_id")) {
          unguarded.push(`${c.name}: missing company_id`);
          continue;
        }
        const stmt = buildScopedInsert(
          colMap,
          c.table,
          A.id,
          { ...c.values, company_id: A.id },
          c.casts,
        );
        const err = await captureRaiseError(client, () => client.query(stmt.sql, stmt.params));
        if (pgErrorCode(err) !== "23503") {
          unguarded.push(`${c.name}: expected 23503, got ${pgErrorCode(err) ?? "allowed"}`);
        }
      }

      expect(unguarded).toEqual([]);
    });
  });

  test("allows identical business keys in A and B while rejecting duplicates within A (FR-006)", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);
      const graphA = await seedCompanyGraph(client, A);
      const graphB = await seedCompanyGraph(client, B);
      const colMap = graphA.colMap;
      const tag = randomUUID().slice(0, 8);
      const failures: string[] = [];

      const runCheck = async (
        table: string,
        insertFn: (companyId: string, suffix: string) => Promise<void>,
      ) => {
        if (!colMap.get(table)?.has("company_id")) {
          failures.push(`${table}: missing company_id`);
          return;
        }
        const failure = await assertPerCompanyUnique(client, table, insertFn, A.id, B.id);
        if (failure) failures.push(failure);
      };

      await runCheck("profiles", async (companyId, suffix) => {
        const uid = randomUUID();
        await client.query(
          `insert into auth.users (id, instance_id, aud, role, email)
           values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
          [uid, `${uid}@auth.ijary.invalid`],
        );
        await client.query(
          `insert into public.profiles (id, company_id, username, email, phone)
           values ($1, $2, $3, $4, $5)
           on conflict (id) do update
             set company_id = excluded.company_id,
                 username = excluded.username,
                 email = excluded.email,
                 phone = excluded.phone`,
          [
            uid,
            companyId,
            `shared_${tag}`,
            `shared-${tag}-${suffix}@example.com`,
            `999${suffix}0001`,
          ],
        );
      });

      await runCheck("tenants", async (companyId, suffix) => {
        const s = buildScopedInsert(colMap, "tenants", companyId, {
          company_id: companyId,
          code: `T-DUP-${tag}`,
          name: `Tenant ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("properties", async (companyId, suffix) => {
        const s = buildScopedInsert(colMap, "properties", companyId, {
          company_id: companyId,
          code: `P-DUP-${tag}`,
          name_ar: `Prop ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("buildings", async (companyId, suffix) => {
        const propId = companyId === A.id ? graphA.ids.propertyId : graphB.ids.propertyId;
        const s = buildScopedInsert(colMap, "buildings", companyId, {
          company_id: companyId,
          code: `B-DUP-${tag}`,
          property_id: propId,
          name_ar: `Bldg ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("units", async (companyId, suffix) => {
        const propId = companyId === A.id ? graphA.ids.propertyId : graphB.ids.propertyId;
        const s = buildScopedInsert(colMap, "units", companyId, {
          company_id: companyId,
          code: `U-DUP-${tag}`,
          property_id: propId,
          name: `Unit ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("contracts", async (companyId, suffix) => {
        const tenantId = companyId === A.id ? graphA.ids.tenantId : graphB.ids.tenantId;
        const s = buildScopedInsert(colMap, "contracts", companyId, {
          company_id: companyId,
          code: `C-DUP-${tag}`,
          tenant_id: tenantId,
          start_date: "2026-01-01",
          end_date: "2026-12-31",
          notes: suffix,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("invoices", async (companyId, suffix) => {
        const g = companyId === A.id ? graphA : graphB;
        const s = buildScopedInsert(colMap, "invoices", companyId, {
          company_id: companyId,
          code: `INV-DUP-${tag}`,
          contract_id: g.ids.contractId,
          tenant_id: g.ids.tenantId,
          period_year: 2027,
          period_month: 4,
          issue_date: "2027-04-01",
          due_date: "2027-04-05",
          idempotency_key: `idem-${tag}-${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("payments", async (companyId, suffix) => {
        const g = companyId === A.id ? graphA : graphB;
        const s = buildScopedInsert(
          colMap,
          "payments",
          companyId,
          {
            company_id: companyId,
            code: `PAY-DUP-${tag}`,
            tenant_id: g.ids.tenantId,
            method: "cash",
            status: "pending",
            amount: Number(suffix) * 10,
            payment_date: "2026-03-01",
          },
          { method: "public.payment_methods" },
        );
        await client.query(s.sql, s.params);
      });

      await runCheck("receipts", async (companyId, suffix) => {
        const g = companyId === A.id ? graphA : graphB;
        const payStmt = buildScopedInsert(
          colMap,
          "payments",
          companyId,
          {
            company_id: companyId,
            code: `PAY-R-${tag}-${suffix}`,
            tenant_id: g.ids.tenantId,
            method: "cash",
            status: "pending",
            amount: 25,
            payment_date: "2026-03-02",
          },
          { method: "public.payment_methods" },
        );
        const payRes = await client.query<{ id: string }>(
          `${payStmt.sql} returning id`,
          payStmt.params,
        );
        const s = buildScopedInsert(colMap, "receipts", companyId, {
          company_id: companyId,
          code: `RCP-DUP-${tag}`,
          payment_id: payRes.rows[0].id,
          tenant_id: g.ids.tenantId,
          amount: 25,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("notification_templates", async (companyId) => {
        const s = buildScopedInsert(
          colMap,
          "notification_templates",
          companyId,
          {
            company_id: companyId,
            code: `tpl_dup_${tag}`,
            type: "manual_message",
            channel: "email",
          },
          { type: "public.notification_types", channel: "public.notification_channels" },
        );
        await client.query(s.sql, s.params);
      });

      await runCheck("cron_jobs", async (companyId, suffix) => {
        const s = buildScopedInsert(colMap, "cron_jobs", companyId, {
          company_id: companyId,
          key: `cj_dup_${tag}`,
          name_ar: `Job ${suffix}`,
          name_en: `Job ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("option_lists", async (companyId, suffix) => {
        const s = buildScopedInsert(colMap, "option_lists", companyId, {
          company_id: companyId,
          code: `ol_dup_${tag}`,
          name_ar: `List ${suffix}`,
          name_en: `List ${suffix}`,
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("invoice_years", async (companyId) => {
        const s = buildScopedInsert(colMap, "invoice_years", companyId, {
          company_id: companyId,
          year: 2035,
        });
        await client.query(s.sql, s.params);
      });

      const {
        rows: [freePerm],
      } = colMap.get("role_permissions")?.has("company_id")
        ? await client.query<{ code: string }>(
            `select p.code from public.permissions p
              where not exists (
                select 1 from public.role_permissions rp
                 where rp.company_id in ($1, $2)
                   and rp.role = 'tenant'::public.app_role
                   and rp.permission_code = p.code
              )
              order by p.code limit 1`,
            [A.id, B.id],
          )
        : { rows: [{ code: "audit.create" }] };

      await runCheck("role_permissions", async (companyId) => {
        const s = buildScopedInsert(
          colMap,
          "role_permissions",
          companyId,
          { company_id: companyId, role: "tenant", permission_code: freePerm.code },
          { role: "public.app_role" },
        );
        await client.query(s.sql, s.params);
      });

      await runCheck("landing_page_settings", async (companyId) => {
        const s = buildScopedInsert(colMap, "landing_page_settings", companyId, {
          company_id: companyId,
          locale: "en",
          hero_title: "t",
          hero_subtitle: "s",
          about_title: "a",
          about_body: "b",
          leasing_title: "l",
          leasing_body: "lb",
        });
        await client.query(s.sql, s.params);
      });

      await runCheck("provider_configs", async (companyId) => {
        const s = buildScopedInsert(
          colMap,
          "provider_configs",
          companyId,
          { company_id: companyId, provider: "resend", is_enabled: false, config: {} },
          { provider: "public.notification_providers", config: "jsonb" },
        );
        await client.query(s.sql, s.params);
      });

      expect(failures).toEqual([]);
    });
  });
});
