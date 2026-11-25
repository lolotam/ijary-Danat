import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

describe("Backup & Restore (migration 146)", () => {
  test("backup_table_names includes contracts, excludes backups", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const { rows } = await client.query<{ backup_table_names: string }>(
        `select * from public.backup_table_names()`,
      );
      const names = rows.map((r) => r.backup_table_names);
      expect(names).toContain("contracts");
      expect(names).not.toContain("backups");
    });
  });

  test("backup_dump_all returns matching fingerprint and [] for empty tables", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const fingerprint = await client.query<{ backup_schema_fingerprint: string }>(
        `select public.backup_schema_fingerprint()`,
      );
      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payload.rows[0].backup_dump_all;

      expect(dump.schema_fingerprint).toBe(fingerprint.rows[0].backup_schema_fingerprint);

      const backupsTable = dump.tables.find((t: any) => t.name === "backups");
      expect(backupsTable).toBeUndefined(); // Excluded table

      const auditTable = dump.tables.find((t: any) => t.name === "audit_logs");
      expect(auditTable).toBeDefined();
      expect(Array.isArray(auditTable.rows)).toBe(true);
    });
  });

  test("invoices round trip: restores row and recomputes GENERATED ALWAYS balance", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const invoiceId = randomUUID();
      await client.query(
        `insert into public.invoices (id, contract_id, tenant_id, idempotency_key, code, period_year, period_month, issue_date, due_date, total, paid, discount)
         values ($1, $2, $3, $4, $5, 2026, 1, '2026-01-01', '2026-01-05', 500, 200, 0)`,
        [invoiceId, contractId, tenantId, randomUUID(), `INV-1`],
      );

      const preRestore = await client.query<{ balance: number }>(
        `select balance from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(Number(preRestore.rows[0].balance)).toBe(300); // 500 - 200

      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );

      // Delete invoice to simulate wipe
      await client.query(`delete from public.invoices where id = $1`, [invoiceId]);
      const missing = await client.query(`select 1 from public.invoices where id = $1`, [
        invoiceId,
      ]);
      expect(missing.rows).toHaveLength(0);

      const adminId = randomUUID();
      const restoreResult = await client.query(
        `select public.backup_restore($1::jsonb, $2::uuid)`,
        [payload.rows[0].backup_dump_all, adminId],
      );

      const postRestore = await client.query<{ balance: number }>(
        `select balance from public.invoices where id = $1`,
        [invoiceId],
      );
      expect(Number(postRestore.rows[0].balance)).toBe(300);

      expect(restoreResult.rows[0]).toBeDefined();
    });
  });

  test("schema drift: wrong fingerprint raises before deleting any rows", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);
      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payload.rows[0].backup_dump_all;
      dump.schema_fingerprint = "fake_drifted_hash";

      const adminId = randomUUID();

      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const error = await captureRaise(client, () =>
        client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [dump, adminId]),
      );

      expect(error).toMatch(/Schema drift detected/);

      const stillExists = await client.query(`select 1 from public.contracts where id = $1`, [
        contractId,
      ]);
      expect(stillExists.rows).toHaveLength(1);
    });
  });

  test("audit_logs rows written after the archive still exist after restore", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );

      const auditId = randomUUID();
      await client.query(`insert into public.audit_logs (id, action) values ($1, 'test_action')`, [
        auditId,
      ]);

      const adminId = randomUUID();
      await client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [
        payload.rows[0].backup_dump_all,
        adminId,
      ]);

      const stillExists = await client.query(`select 1 from public.audit_logs where id = $1`, [
        auditId,
      ]);
      expect(stillExists.rows).toHaveLength(1);
    });
  });

  test("auth.users FKs: set-null is nulled, cascade/restrict skips row", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const keepUserId = randomUUID();
      const dropUserId1 = randomUUID();
      const dropUserId2 = randomUUID();

      for (const id of [keepUserId, dropUserId1, dropUserId2]) {
        await client.query(
          `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
          [id],
        );
      }

      const { contractId, tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const paymentId = randomUUID();
      await client.query(
        `insert into public.payments (id, tenant_id, amount, currency, method, code, payment_date, created_by)
         values ($1, $2, 100, 'KWD', 'cash', 'PAY-1', '2026-01-01', $3)`,
        [paymentId, tenantId, dropUserId1],
      );

      await client.query(
        `insert into public.profiles (id, display_name) values ($1, 'Drop Me') on conflict (id) do update set display_name = excluded.display_name`,
        [dropUserId2],
      );

      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );

      await client.query(`delete from auth.users where id in ($1, $2)`, [dropUserId1, dropUserId2]);

      const adminId = keepUserId;
      const restoreResult = await client.query<{ backup_restore: any }>(
        `select public.backup_restore($1::jsonb, $2::uuid)`,
        [payload.rows[0].backup_dump_all, adminId],
      );

      const report = restoreResult.rows[0].backup_restore;

      const paymentCheck = await client.query(
        `select created_by from public.payments where id = $1`,
        [paymentId],
      );
      expect(paymentCheck.rows).toHaveLength(1);
      expect(paymentCheck.rows[0].created_by).toBeNull();

      const profileCheck = await client.query(`select 1 from public.profiles where id = $1`, [
        dropUserId2,
      ]);
      expect(profileCheck.rows).toHaveLength(0);

      expect(report.skipped_by_table.profiles).toBeGreaterThanOrEqual(1);
    });
  });

  test("actor keeps admin role when payload omits them", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const payload = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );

      const adminId = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [adminId],
      );

      await client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [
        payload.rows[0].backup_dump_all,
        adminId,
      ]);

      const profile = await client.query(`select 1 from public.profiles where id = $1`, [adminId]);
      expect(profile.rows).toHaveLength(1);

      const role = await client.query(`select role from public.user_roles where user_id = $1`, [
        adminId,
      ]);
      expect(role.rows[0].role).toBe("admin");
    });
  });

  test("unique (kind, period_key) rejects a second automatic backup", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      await client.query(
        `insert into public.backups (file_name, storage_path, sha256, size_bytes, table_count, row_count, kind, period_key)
         values ('file1.zip', 'path1', 'hash1', 1, 1, 1, 'automatic', 'd:2026-08-17')`,
      );

      const error = await captureRaise(client, () =>
        client.query(
          `insert into public.backups (file_name, storage_path, sha256, size_bytes, table_count, row_count, kind, period_key)
           values ('file2.zip', 'path2', 'hash2', 1, 1, 1, 'automatic', 'd:2026-08-17')`,
        ),
      );
      expect(error).toMatch(/duplicate key value/);
    });
  });

  test("incomplete payload raises before deleting any rows", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const { contractId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      const payloadRes = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payloadRes.rows[0].backup_dump_all;

      dump.tables = dump.tables.filter((t: any) => t.name !== "contracts");

      const adminId = randomUUID();
      const error = await captureRaise(client, () =>
        client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [dump, adminId]),
      );

      expect(error).toMatch(/Payload is missing tables: contracts/);

      const stillExists = await client.query(`select 1 from public.contracts where id = $1`, [
        contractId,
      ]);
      expect(stillExists.rows).toHaveLength(1);
    });
  });

  test("duplicate table entry in payload is rejected", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const payloadRes = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payloadRes.rows[0].backup_dump_all;

      if (dump.tables.length > 0) {
        dump.tables.push(dump.tables[0]);
      }

      const adminId = randomUUID();
      const error = await captureRaise(client, () =>
        client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [dump, adminId]),
      );

      expect(error).toMatch(/Payload contains duplicate entries/);
    });
  });

  test("dangling profile reference raises and rolls back", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const adminId = randomUUID();
      const profileId = randomUUID();

      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [adminId],
      );
      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [profileId],
      );

      await client.query(
        `insert into public.profiles (id, display_name) values ($1, 'Admin') on conflict (id) do update set display_name = excluded.display_name`,
        [adminId],
      );
      await client.query(
        `insert into public.profiles (id, display_name) values ($1, 'Sender') on conflict (id) do update set display_name = excluded.display_name`,
        [profileId],
      );

      const { tenantId } = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });

      await client.query(
        `insert into public.tenant_messages (id, sender_profile_id, tenant_id, subject, body)
         values ($1, $2, $3, 'Subj', 'Content')`,
        [randomUUID(), profileId, tenantId],
      );

      const payloadRes = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payloadRes.rows[0].backup_dump_all;

      await client.query(`delete from auth.users where id = $1`, [profileId]);

      const error = await captureRaise(client, async () => {
        const restoreAdminId = randomUUID();
        await client.query(
          `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
          [restoreAdminId],
        );
        await client.query(
          `insert into public.profiles (id, display_name) values ($1, 'Admin') on conflict (id) do update set display_name = excluded.display_name`,
          [restoreAdminId],
        );
        return client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [
          dump,
          restoreAdminId,
        ]);
      });

      expect(error).toMatch(/Restore leaves \d+ dangling references in constraint .* on table/);
    });
  });

  test("fingerprint changes when a column type changes", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const res1 = await client.query<{ backup_schema_fingerprint: string }>(
        `select public.backup_schema_fingerprint()`,
      );
      const fg1 = res1.rows[0].backup_schema_fingerprint;

      await client.query(`alter table public.invoices alter column subtotal type numeric(14,4)`);

      const res2 = await client.query<{ backup_schema_fingerprint: string }>(
        `select public.backup_schema_fingerprint()`,
      );
      const fg2 = res2.rows[0].backup_schema_fingerprint;

      expect(fg1).not.toBe(fg2);
    });
  });

  test("successful restore leaves an audit_logs row for backup.restore", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const adminId = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [adminId],
      );
      await client.query(
        `insert into public.profiles (id, display_name) values ($1, 'Admin') on conflict (id) do update set display_name = excluded.display_name`,
        [adminId],
      );

      const payloadRes = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payloadRes.rows[0].backup_dump_all;

      const archiveId = randomUUID();
      const payload = {
        format_version: dump.format_version,
        schema_fingerprint: dump.schema_fingerprint,
        archive_id: archiveId,
        tables: dump.tables,
      };

      const restoreAdminId = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [restoreAdminId],
      );
      await client.query(
        `insert into public.profiles (id, display_name) values ($1, 'Admin2') on conflict (id) do update set display_name = excluded.display_name`,
        [restoreAdminId],
      );

      await client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [
        payload,
        restoreAdminId,
      ]);

      const auditRes = await client.query(
        `select * from public.audit_logs where action = 'backup.restore' and entity_id = $1`,
        [archiveId],
      );
      expect(auditRes.rows).toHaveLength(1);
      // write_audit reads auth.uid(), which is null on the service-key path,
      // so the actor is carried explicitly in the report it stores as `after`.
      expect(auditRes.rows[0].after.actor).toBe(restoreAdminId);
      expect(auditRes.rows[0].result).toBe("success");
    });
  });

  test("actor profile active state and admin role are preserved", async () => {
    await withRollback(async (client) => {
      await actAsSuperuser(client);

      const adminId = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`,
        [adminId],
      );
      // In backup, actor is inactive
      await client.query(
        `insert into public.profiles (id, display_name, is_active) values ($1, 'Admin Inactive', false)
         on conflict (id) do update set display_name = excluded.display_name, is_active = excluded.is_active`,
        [adminId],
      );

      const payloadRes = await client.query<{ backup_dump_all: any }>(
        `select public.backup_dump_all()`,
      );
      const dump = payloadRes.rows[0].backup_dump_all;

      // Currently, actor is active
      await client.query(
        `update public.profiles set is_active = true, display_name = 'Admin Active' where id = $1`,
        [adminId],
      );

      const archiveId = randomUUID();
      const payload = {
        format_version: dump.format_version,
        schema_fingerprint: dump.schema_fingerprint,
        archive_id: archiveId,
        tables: dump.tables,
      };

      await client.query(`select public.backup_restore($1::jsonb, $2::uuid)`, [payload, adminId]);

      const profile = await client.query(
        `select is_active, display_name from public.profiles where id = $1`,
        [adminId],
      );
      expect(profile.rows[0].is_active).toBe(true);
      expect(profile.rows[0].display_name).toBe("Admin Active");

      const role = await client.query(`select public.has_role($1::uuid, 'admin') as has_admin`, [
        adminId,
      ]);
      expect(role.rows[0].has_admin).toBe(true);
    });
  });

  test("anon cannot execute any of the new functions", async () => {
    await withRollback(async (client) => {
      await actAs(client, "anon");

      const calls = [
        `select * from public.backup_table_names()`,
        `select * from public.backup_protected_tables()`,
        `select * from public.backup_excluded_tables()`,
        `select public.backup_schema_fingerprint()`,
        `select public.backup_dump_all()`,
        `select public.backup_restore('{}'::jsonb, null)`,
      ];

      for (const call of calls) {
        const error = await captureRaise(client, () => client.query(call));
        expect(error).toMatch(/permission denied/);
      }
    });
  });
});
