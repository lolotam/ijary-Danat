import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import {
  COMPANY_ROLES,
  actAsCompanyService,
  actAsCompanyUser,
  runAsCompanyService,
  runAsUser,
  seedTwoCompanies,
  setCompanyStatus,
} from "@/db/isolation/twoCompanies";
import { actAs, actAsSuperuser, captureRaise, closePool, withRollback } from "@/db/testDb";

afterAll(closePool);

describe("migration 254 company context and twoCompanies harness", () => {
  test("seeds active companies A and B with all five roles and primary subdomain hosts", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      expect(A.id).not.toBe(B.id);
      expect(A.slug).not.toBe(B.slug);

      for (const role of COMPANY_ROLES) {
        expect(A.users[role].companyId).toBe(A.id);
        expect(B.users[role].companyId).toBe(B.id);

        await runAsUser(client, A.users[role], async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBe(A.id);
        });

        await runAsUser(client, B.users[role], async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBe(B.id);
        });
      }

      const { rows: domains } = await client.query<{ host: string; company_id: string }>(
        `select host, company_id from public.company_domains where company_id in ($1, $2)`,
        [A.id, B.id],
      );
      expect(domains).toHaveLength(2);
      expect(domains).toEqual(
        expect.arrayContaining([
          { host: A.host, company_id: A.id },
          { host: B.host, company_id: B.id },
        ]),
      );
    });
  });

  test("ignores a forged company_id claim on an authenticated token and fails closed on impersonation_session", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      await runAsUser(
        client,
        A.users.admin,
        async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBe(A.id);
        },
        { company_id: B.id, allow_suspended: true },
      );

      await runAsUser(
        client,
        A.users.admin,
        async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBeNull();
        },
        { impersonation_session: randomUUID() },
      );
    });
  });

  test("company_service resolves its claim company, reads only its own company_domains, and fails closed without a claim", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client);

      await runAsCompanyService(client, A.id, async () => {
        const { rows: ctx } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(ctx[0].cid).toBe(A.id);

        const { rows: domains } = await client.query<{ company_id: string }>(
          `select company_id from public.company_domains where company_id in ($1, $2)`,
          [A.id, B.id],
        );
        expect(domains.map((r) => r.company_id)).toEqual([A.id]);
      });

      await runAsCompanyService(client, null, async () => {
        const { rows: ctx } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(ctx[0].cid).toBeNull();

        const { rows: domains } = await client.query<{ company_id: string }>(
          `select company_id from public.company_domains where company_id in ($1, $2)`,
          [A.id, B.id],
        );
        expect(domains).toEqual([]);
      });
    });
  });

  test("returns null for suspended companies unless company_service carries allow_suspended", async () => {
    await withRollback(async (client) => {
      const { A, B } = await seedTwoCompanies(client, { statusA: "suspended" });

      await runAsUser(client, A.users.admin, async () => {
        const { rows } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(rows[0].cid).toBeNull();
      });

      await runAsCompanyService(client, A.id, async () => {
        const { rows } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(rows[0].cid).toBeNull();
      });

      await runAsCompanyService(
        client,
        A.id,
        async () => {
          const { rows } = await client.query<{ cid: string | null }>(
            `select public.current_company_id() as cid`,
          );
          expect(rows[0].cid).toBe(A.id);
        },
        { allowSuspended: true },
      );

      // Reactivating restores access for A while leaving B untouched.
      await setCompanyStatus(client, A.id, "active");
      await runAsUser(client, A.users.admin, async () => {
        const { rows } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(rows[0].cid).toBe(A.id);
      });
      await runAsUser(client, B.users.admin, async () => {
        const { rows } = await client.query<{ cid: string | null }>(
          `select public.current_company_id() as cid`,
        );
        expect(rows[0].cid).toBe(B.id);
      });
    });
  });

  test("enforces reserved slugs, slug immutability, no delete grant on companies, and is_platform_admin stub", async () => {
    await withRollback(async (client) => {
      const { A } = await seedTwoCompanies(client);

      const reservedErr = await captureRaise(client, () =>
        client.query(
          `insert into public.companies (name_ar, name_en, slug)
           values ('شركة محجوزة', 'Reserved Co', 'admin')`,
        ),
      );
      expect(reservedErr).toMatch(/SLUG_RESERVED/);

      const immutableErr = await captureRaise(client, () =>
        client.query(`update public.companies set slug = 'new-slug-1' where id = $1`, [A.id]),
      );
      expect(immutableErr).toMatch(/SLUG_IMMUTABLE/);

      // Adding an existing company's slug to reserved_slugs later must not block updating its row.
      await client.query(`insert into public.reserved_slugs (slug) values ($1)`, [A.slug]);
      await setCompanyStatus(client, A.id, "suspended", "Later reservation test");
      await setCompanyStatus(client, A.id, "active");

      // Custom domains default to 'pending' (fail closed); subdomains require 'verified'.
      const { rows: customDomain } = await client.query<{ verification_status: string }>(
        `insert into public.company_domains (company_id, host, kind)
         values ($1, $2, 'custom') returning verification_status`,
        [A.id, `custom-${A.slug}.example.com`],
      );
      expect(customDomain[0].verification_status).toBe("pending");

      const unverifiedSubdomainErr = await captureRaise(client, () =>
        client.query(
          `insert into public.company_domains (company_id, host, kind)
           values ($1, $2, 'subdomain')`,
          [A.id, `pending-${A.slug}.ijary.app`],
        ),
      );
      expect(unverifiedSubdomainErr).toMatch(/company_domains_subdomain_verified/i);

      // Default privileges grant table + sequence access on newly created public tables to company_service.
      await client.query(
        `create table public._tmp_company_service_priv_check (id serial primary key, note text)`,
      );
      const { rows: privRows } = await client.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_seq: boolean;
      }>(
        `select has_table_privilege('company_service', 'public._tmp_company_service_priv_check', 'SELECT') as can_select,
                has_table_privilege('company_service', 'public._tmp_company_service_priv_check', 'INSERT') as can_insert,
                has_table_privilege('company_service', 'public._tmp_company_service_priv_check', 'UPDATE') as can_update,
                has_table_privilege('company_service', 'public._tmp_company_service_priv_check', 'DELETE') as can_delete,
                has_sequence_privilege('company_service', 'public._tmp_company_service_priv_check_id_seq', 'USAGE') as can_seq`,
      );
      expect(privRows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
        can_seq: true,
      });

      const { rows: delGrants } = await client.query<{ grantee: string }>(
        `select grantee from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'companies'
            and privilege_type = 'DELETE'
            and grantee in ('PUBLIC', 'anon', 'authenticated', 'company_service', 'service_role')`,
      );
      expect(delGrants).toEqual([]);

      await actAsCompanyUser(client, A.users.admin);
      const { rows: adminStub } = await client.query<{ ok: boolean }>(
        `select public.is_platform_admin() as ok`,
      );
      expect(adminStub[0].ok).toBe(false);
      await actAsSuperuser(client);

      // anon cannot execute current_company_id or is_platform_admin.
      await actAs(client, "anon");
      expect(
        await captureRaise(client, () => client.query(`select public.current_company_id()`)),
      ).toMatch(/permission denied/i);
      expect(
        await captureRaise(client, () => client.query(`select public.is_platform_admin()`)),
      ).toMatch(/permission denied/i);
      await actAsSuperuser(client);

      // Verify actAsCompanyService cleans up cleanly when switched back.
      await actAsCompanyService(client, A.id);
      await actAsSuperuser(client);
      const { rows: roleCheck } = await client.query<{ current_user: string }>(
        `select current_user`,
      );
      expect(roleCheck[0].current_user).toBe("postgres");
    });
  });
});
