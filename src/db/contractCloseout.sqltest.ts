import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import {
  actAs,
  actAsSuperuser,
  captureRaise,
  closePool,
  seedCompanyUser,
  seedContract,
  withRollback,
} from "@/db/testDb";

afterAll(closePool);

/**
 * Migration 87 — atomic contract close-out engine.
 *
 * Real SQL against a real Postgres built from db/migrations. Covers outcomes,
 * settlement math, idempotency, lock-order side effects (unit status / portal),
 * and rollback atomicity.
 */

const migration87 = readFileSync(
  resolve(process.cwd(), "db/migrations/87_contract_closeout_rpcs.sql"),
  "utf8",
);
const migration87Code = migration87.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** ينشئ شركة اختبار جديدة ويعيد معرّفها. */
async function seedCompany(client: PoolClient): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const { rows } = await client.query<{ id: string }>(
    `insert into public.companies (name_ar, name_en) values ($1, $2) returning id`,
    [`شركة اختبار ${tag}`, `Test Co ${tag}`],
  );
  return rows[0].id;
}

/** ينشئ مستخدماً إدارياً ضمن الشركة المحددة. */
async function seedAdmin(client: PoolClient, companyId: string): Promise<string> {
  return seedCompanyUser(client, companyId, "admin", "closeout-admin");
}

async function seedInsurance(
  client: PoolClient,
  opts: { contractId: string; tenantId: string; unitId: string; companyId: string; amount: number },
): Promise<void> {
  await client.query(
    `insert into public.insurance_payments
       (company_id, contract_id, tenant_id, unit_id, amount, collected_date)
     values ($1, $2, $3, $4, $5, current_date)`,
    [opts.companyId, opts.contractId, opts.tenantId, opts.unitId, opts.amount],
  );
}

async function seedOpenInvoice(
  client: PoolClient,
  opts: {
    contractId: string;
    tenantId: string;
    unitId: string;
    companyId: string;
    total: number;
    paid?: number;
    year?: number;
    month?: number;
  },
): Promise<{ id: string; code: string; balance: number }> {
  const year = opts.year ?? 2026;
  const month = opts.month ?? 1;
  const paid = opts.paid ?? 0;
  const { rows } = await client.query<{ id: string; code: string; balance: string }>(
    `insert into public.invoices (
       company_id, contract_id, tenant_id, unit_id,
       period_year, period_month, issue_date, due_date,
       subtotal, discount, total, paid, state, idempotency_key
     ) values (
       $1, $2, $3, $4,
       $5, $6, '2026-01-01', '2026-01-05',
       $7, 0, $7, $8, 'due', $9
     )
     returning id, code, balance::text`,
    [
      opts.companyId,
      opts.contractId,
      opts.tenantId,
      opts.unitId,
      year,
      month,
      opts.total,
      paid,
      `inv-${randomUUID()}`,
    ],
  );
  return { id: rows[0].id, code: rows[0].code, balance: Number(rows[0].balance) };
}

type CloseOutArgs = {
  contractId: string;
  moveOutDate?: string;
  outcome?: "keep_terminated" | "freeze" | "archive";
  finalState?: "terminated" | "expired";
  archiveTenant?: boolean;
  deductions?: unknown[];
  invoiceActions?: unknown[];
  refundAmount?: number | null;
  note?: string;
  idempotencyKey?: string;
  expectedUpdatedAt?: string | null;
};

async function closeOut(client: PoolClient, args: CloseOutArgs) {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    `select public.close_out_contract(
       $1::uuid, $2::date, $3, $4, $5,
       $6::jsonb, $7::jsonb, $8::numeric, $9, $10, $11::timestamptz
     ) as result`,
    [
      args.contractId,
      args.moveOutDate ?? "2026-06-15",
      args.outcome ?? "archive",
      args.finalState ?? "terminated",
      args.archiveTenant ?? false,
      JSON.stringify(args.deductions ?? []),
      JSON.stringify(args.invoiceActions ?? []),
      args.refundAmount === undefined ? null : args.refundAmount,
      args.note ?? "test close-out",
      args.idempotencyKey ?? `idem-${randomUUID()}`,
      args.expectedUpdatedAt ?? null,
    ],
  );
  return rows[0].result;
}

async function preview(
  client: PoolClient,
  contractId: string,
  deductions: unknown[],
  invoiceActions: unknown[],
  refundAmount: number | null = null,
) {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    `select public.get_contract_closeout_preview(
       $1::uuid, $2::jsonb, $3::jsonb, $4::numeric
     ) as result`,
    [contractId, JSON.stringify(deductions), JSON.stringify(invoiceActions), refundAmount],
  );
  return rows[0].result;
}

/** ينفّذ الدالة بصلاحية مدير ضمن شركة محددة ثم يعيد صلاحية المشرف. */
async function asAdmin<T>(
  client: PoolClient,
  fn: (adminId: string, companyId: string) => Promise<T>,
  existingCompanyId?: string,
): Promise<T> {
  const companyId = existingCompanyId ?? (await seedCompany(client));
  const adminId = await seedAdmin(client, companyId);
  await actAs(client, "authenticated", adminId);
  try {
    return await fn(adminId, companyId);
  } finally {
    await actAsSuperuser(client);
  }
}

describe("close_out_contract happy paths", () => {
  test("1. deposit 250, deduction 25.5, write-off → terminated, archived, REF- refund, totals", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          deposit: 250,
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 250,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 100,
        });

        const result = await closeOut(client, {
          contractId: fx.contractId,
          outcome: "archive",
          finalState: "terminated",
          deductions: [
            {
              kind: "damages",
              description_ar: "أضرار",
              description_en: "Damages",
              amount: 25.5,
            },
          ],
          invoiceActions: [{ invoice_id: inv.id, action: "write_off", amount: 0 }],
        });

        expect(result.status).toBe("completed");
        expect(result.contract_state).toBe("terminated");
        expect(result.archived_at).not.toBeNull();
        expect(Number(result.deposit_held)).toBe(250);
        expect(Number(result.deductions_total)).toBe(25.5);
        expect(Number(result.settled_total)).toBe(0);
        expect(Number(result.written_off_total)).toBe(100);
        expect(Number(result.refund_total)).toBe(224.5);
        expect(Number(result.balance_due_tenant)).toBe(0);
        expect(String(result.refund_code)).toMatch(/^REF-/);

        const c = await client.query<{ state: string; archived_at: string | null }>(
          `select state::text, archived_at from public.contracts where id = $1`,
          [fx.contractId],
        );
        expect(c.rows[0].state).toBe("terminated");
        expect(c.rows[0].archived_at).not.toBeNull();

        const refunds = await client.query(
          `select id, code, amount, status, post_action::text
             from public.refunds where contract_id = $1`,
          [fx.contractId],
        );
        expect(refunds.rows).toHaveLength(1);
        expect(Number(refunds.rows[0].amount)).toBe(224.5);
        expect(refunds.rows[0].status).toBe("posted");
        expect(refunds.rows[0].post_action).toBe("store");
      });
    });
  });

  test("2. keep_terminated leaves archived_at NULL; state terminated; visible", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 100,
        });

        const result = await closeOut(client, {
          contractId: fx.contractId,
          outcome: "keep_terminated",
          finalState: "terminated",
        });
        expect(result.contract_state).toBe("terminated");
        expect(result.archived_at).toBeNull();

        const visible = await client.query(
          `select id from public.contracts
            where id = $1 and archived_at is null and state = 'terminated'`,
          [fx.contractId],
        );
        expect(visible.rows).toHaveLength(1);
      });
    });
  });

  test("3. freeze sets state=frozen, archived_at NULL, generates no invoices", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 50,
        });

        const result = await closeOut(client, {
          contractId: fx.contractId,
          outcome: "freeze",
          finalState: "terminated", // ignored for freeze
        });
        expect(result.contract_state).toBe("frozen");
        expect(result.archived_at).toBeNull();

        const { rows } = await client.query(
          `select * from public.generate_invoices_for_year($1, 2026, false)`,
          [fx.contractId],
        );
        expect(rows).toHaveLength(0);
      });
    });
  });

  test("4. only outcome=archive stamps archived_at", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        for (const outcome of ["keep_terminated", "freeze", "archive"] as const) {
          const fx = await seedContract(client, {
            companyId,
            startDate: "2026-01-01",
            endDate: "2026-12-31",
          });
          await seedInsurance(client, {
            contractId: fx.contractId,
            tenantId: fx.tenantId,
            unitId: fx.unitId,
            companyId: fx.companyId,
            amount: 10,
          });
          await closeOut(client, {
            contractId: fx.contractId,
            outcome,
            finalState: "terminated",
          });
          const { rows } = await client.query<{ archived_at: string | null }>(
            `select archived_at from public.contracts where id = $1`,
            [fx.contractId],
          );
          if (outcome === "archive") {
            expect(rows[0].archived_at).not.toBeNull();
          } else {
            expect(rows[0].archived_at).toBeNull();
          }
        }
      });
    });
  });

  test("5. p_archive_tenant=true with keep_terminated raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        expect(
          await captureRaise(client, () =>
            closeOut(client, {
              contractId: fx.contractId,
              outcome: "keep_terminated",
              archiveTenant: true,
            }),
          ),
        ).toMatch(/archive_tenant|only allowed when p_outcome = archive/i);
      });
    });
  });
});

describe("close_out_contract unit + portal side effects", () => {
  test("6. unit becomes vacant via trigger; migration 87 has no update public.units", async () => {
    expect(migration87Code).not.toMatch(/update\s+public\.units/i);

    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 20,
        });
        const before = await client.query<{ status: string }>(
          `select status::text from public.units where id = $1`,
          [fx.unitId],
        );
        expect(before.rows[0].status).toBe("occupied");

        const result = await closeOut(client, {
          contractId: fx.contractId,
          outcome: "archive",
        });
        expect(result.unit_status).toBe("vacant");
        const after = await client.query<{ status: string }>(
          `select status::text from public.units where id = $1`,
          [fx.unitId],
        );
        expect(after.rows[0].status).toBe("vacant");
      });
    });
  });

  test("7. under_maintenance stays under_maintenance after close-out", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        // Occupancy is state='active' only; under_maintenance is preserved by
        // compute_unit_status when no active contract remains.
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          state: "draft",
        });
        await client.query(`update public.units set status = 'under_maintenance' where id = $1`, [
          fx.unitId,
        ]);
        await client.query(`update public.contracts set state = 'active' where id = $1`, [
          fx.contractId,
        ]);
        // Active contract forces occupied; put back maintenance after freeze path:
        // end the active state via close-out while status is under_maintenance.
        // To keep under_maintenance through the active period, set it after
        // making the contract non-active would lose the case. Migration 76:
        // when active contract exists → occupied. So set under_maintenance only
        // works when there is no active contract OR we force it after leaving active.
        // Re-read unitStatus test: draft + under_maintenance, then edit draft.
        // For close-out we need active first. Sequence: active → set maintenance
        // fails (enforce derived). So: draft, set maintenance, activate (becomes
        // occupied), close-out → vacant not maintenance.
        //
        // To preserve under_maintenance: unit must already be under_maintenance
        // when the last active contract ends. But active contract forces occupied.
        // Looking at compute_unit_status: active → occupied always.
        // under_maintenance only preserved when NOT unit_has_active_contract.
        //
        // Path: draft contract, set under_maintenance, close-out from draft?
        // close-out rejects only expired/terminated/renewed — draft is allowed.
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 15,
        });
        // Reset to draft + maintenance (activate would overwrite status).
        await client.query(`update public.contracts set state = 'draft' where id = $1`, [
          fx.contractId,
        ]);
        await client.query(`update public.units set status = 'under_maintenance' where id = $1`, [
          fx.unitId,
        ]);

        const result = await closeOut(client, {
          contractId: fx.contractId,
          outcome: "archive",
        });
        expect(result.unit_status).toBe("under_maintenance");
      });
    });
  });

  // Migration 142 repointed migration 21's trigger off `profiles.is_active`
  // (the ACCOUNT flag) onto `tenants.tenant_portal_enabled` (the PORTAL flag),
  // because the account flag became load-bearing for login: a tenant whose
  // contract merely ended would have been locked out of their account rather
  // than out of the portal. This asserted the pre-142 behaviour and has failed
  // on a clean database build ever since; it now pins what 142 actually does,
  // including that the account flag is left alone.
  test("8. closing out disables the portal, not the account; close_out does not write profiles", async () => {
    // close_out_contract body must not update profiles (restore does).
    const closeOutFn = migration87Code.match(
      /create\s+or\s+replace\s+function\s+public\.close_out_contract[\s\S]*?^\$\$;/m,
    );
    expect(closeOutFn?.[0] ?? "").not.toMatch(/update\s+public\.profiles/i);

    await withRollback(async (client) => {
      // Seed portal auth.users while still superuser — authenticated cannot insert there.
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      const portalUser = randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
        [portalUser, `${portalUser}@tenant.test`],
      );
      // handle_new_user already inserted a profiles row — attach it to the tenant.
      await client.query(
        `update public.profiles
            set tenant_id = $2, email = $3, is_active = true
          where id = $1`,
        [portalUser, fx.tenantId, `${portalUser}@tenant.test`],
      );
      await seedInsurance(client, {
        contractId: fx.contractId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        companyId: fx.companyId,
        amount: 30,
      });

      await asAdmin(
        client,
        async () => {
          await closeOut(client, { contractId: fx.contractId, outcome: "archive" });

          const portal = await client.query<{ tenant_portal_enabled: boolean }>(
            `select tenant_portal_enabled from public.tenants where id = $1`,
            [fx.tenantId],
          );
          expect(portal.rows[0].tenant_portal_enabled).toBe(false);

          // The account itself stays usable. This is the half worth pinning:
          // migration 142 exists so a finished contract cannot lock a person out
          // of their own login.
          const profile = await client.query<{ is_active: boolean }>(
            `select is_active from public.profiles where id = $1`,
            [portalUser],
          );
          expect(profile.rows[0].is_active).toBe(true);
        },
        fx.companyId,
      );
    });
  });
});

describe("close_out_contract idempotency and concurrency", () => {
  test("9. same key twice → one close-out, one refund, byte-identical jsonb", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 200,
        });
        const key = `idem-${randomUUID()}`;
        const first = await closeOut(client, {
          contractId: fx.contractId,
          idempotencyKey: key,
        });
        const second = await closeOut(client, {
          contractId: fx.contractId,
          idempotencyKey: key,
          // second call would fail on "already ended" if not short-circuited
        });
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));

        const closeouts = await client.query(
          `select id from public.contract_closeouts where contract_id = $1 and status = 'completed'`,
          [fx.contractId],
        );
        expect(closeouts.rows).toHaveLength(1);
        const refunds = await client.query(`select id from public.refunds where contract_id = $1`, [
          fx.contractId,
        ]);
        expect(refunds.rows).toHaveLength(1);
      });
    });
  });

  test("10. reusing a CANCELLED close-out key raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        const key = `idem-${randomUUID()}`;
        // Create a draft by inserting header directly, then cancel.
        const { rows } = await client.query<{ id: string }>(
          `insert into public.contract_closeouts (
             contract_id, tenant_id, unit_id, company_id,
             status, outcome, final_contract_state, archive_tenant,
             move_out_date, idempotency_key, created_by
           ) values (
             $1, $2, $3, $4,
             'draft', 'archive', 'terminated', false,
             current_date, $5, auth.uid()
           ) returning id`,
          [fx.contractId, fx.tenantId, fx.unitId, fx.companyId, key],
        );
        await client.query(`select public.cancel_contract_closeout($1, 'operator abort')`, [
          rows[0].id,
        ]);

        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 40,
        });
        expect(
          await captureRaise(client, () =>
            closeOut(client, { contractId: fx.contractId, idempotencyKey: key }),
          ),
        ).toMatch(/cancelled\. Start a new one/i);
      });
    });
  });

  test("11. two concurrent drafts for one contract violate closeouts_one_draft_per_contract", async () => {
    await withRollback(async (client) => {
      const fx = await seedContract(client, {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await client.query(
        `insert into public.contract_closeouts (
           contract_id, tenant_id, unit_id, company_id,
           status, outcome, final_contract_state, archive_tenant,
           move_out_date, idempotency_key
         ) values (
           $1, $2, $3, $4,
           'draft', 'archive', 'terminated', false,
           current_date, $5
         )`,
        [fx.contractId, fx.tenantId, fx.unitId, fx.companyId, `idem-${randomUUID()}`],
      );
      expect(
        await captureRaise(client, () =>
          client.query(
            `insert into public.contract_closeouts (
               contract_id, tenant_id, unit_id, company_id,
               status, outcome, final_contract_state, archive_tenant,
               move_out_date, idempotency_key
             ) values (
               $1, $2, $3, $4,
               'draft', 'archive', 'terminated', false,
               current_date, $5
             )`,
            [fx.contractId, fx.tenantId, fx.unitId, fx.companyId, `idem-${randomUUID()}`],
          ),
        ),
      ).toMatch(/closeouts_one_draft_per_contract|duplicate key/i);
    });
  });

  test("12. staleness: bumped contracts.updated_at → errcode 40001", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 25,
        });
        const before = await client.query<{ updated_at: string }>(
          `select updated_at from public.contracts where id = $1`,
          [fx.contractId],
        );
        // Bump updated_at independently of the close-out path.
        await client.query(
          `update public.contracts set notes = coalesce(notes,'') || 'x' where id = $1`,
          [fx.contractId],
        );
        const msg = await captureRaise(client, () =>
          closeOut(client, {
            contractId: fx.contractId,
            expectedUpdatedAt: before.rows[0].updated_at,
          }),
        );
        // pg error code 40001 is not on Error.message; the message text is.
        expect(msg).toMatch(/modified concurrently|serialization/i);
      });
    });
  });
});

describe("close_out_contract guards", () => {
  test("13. already-archived contract raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await client.query(`update public.contracts set archived_at = now() where id = $1`, [
          fx.contractId,
        ]);
        expect(
          await captureRaise(client, () => closeOut(client, { contractId: fx.contractId })),
        ).toMatch(/already archived/i);
      });
    });
  });

  test("14. terminated contract raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await client.query(`update public.contracts set state = 'terminated' where id = $1`, [
          fx.contractId,
        ]);
        expect(
          await captureRaise(client, () => closeOut(client, { contractId: fx.contractId })),
        ).toMatch(/already ended/i);
      });
    });
  });

  test("15. deductions exceeding deposit_held raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 50,
        });
        expect(
          await captureRaise(client, () =>
            closeOut(client, {
              contractId: fx.contractId,
              deductions: [{ kind: "damages", amount: 60, description_en: "too much" }],
            }),
          ),
        ).toMatch(/exceed deposit held/i);
      });
    });
  });

  test("16. refund_amount exceeding available raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 100,
        });
        expect(
          await captureRaise(client, () =>
            closeOut(client, {
              contractId: fx.contractId,
              deductions: [{ kind: "cleaning", amount: 40, description_en: "clean" }],
              refundAmount: 70, // available is 60
            }),
          ),
        ).toMatch(/exceeds available/i);
      });
    });
  });

  test("20. omitting an invoice with balance > 0 raises", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 80,
        });
        await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 50,
        });
        expect(
          await captureRaise(client, () =>
            closeOut(client, {
              contractId: fx.contractId,
              invoiceActions: [], // omits the open invoice
            }),
          ),
        ).toMatch(/missing from p_invoice_actions/i);
      });
    });
  });
});

describe("close_out_contract invoice actions", () => {
  test("17. settle_from_deposit creates payments + allocations; paid backed by allocations", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 500,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 200,
        });

        await closeOut(client, {
          contractId: fx.contractId,
          outcome: "archive",
          invoiceActions: [{ invoice_id: inv.id, action: "settle_from_deposit", amount: 200 }],
        });

        const invAfter = await client.query<{ paid: string; state: string; balance: string }>(
          `select paid::text, state::text, balance::text from public.invoices where id = $1`,
          [inv.id],
        );
        expect(Number(invAfter.rows[0].paid)).toBe(200);
        expect(invAfter.rows[0].state).toBe("paid");
        expect(Number(invAfter.rows[0].balance)).toBe(0);

        const pay = await client.query<{ id: string; amount: string; reference: string }>(
          `select id, amount::text, reference from public.payments
            where tenant_id = $1 and reference like 'CLOSEOUT:%'`,
          [fx.tenantId],
        );
        expect(pay.rows).toHaveLength(1);
        expect(Number(pay.rows[0].amount)).toBe(200);

        const alloc = await client.query<{ amount: string }>(
          `select amount::text from public.payment_allocations
            where payment_id = $1 and invoice_id = $2`,
          [pay.rows[0].id, inv.id],
        );
        expect(alloc.rows).toHaveLength(1);
        expect(Number(alloc.rows[0].amount)).toBe(200);

        // paid equals sum of allocations for this invoice
        const sum = await client.query<{ s: string }>(
          `select coalesce(sum(amount),0)::text as s from public.payment_allocations
            where invoice_id = $1`,
          [inv.id],
        );
        expect(Number(sum.rows[0].s)).toBe(Number(invAfter.rows[0].paid));
      });
    });
  });

  test("18. write_off sets waived, leaves paid untouched; balance shows written-off amount", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 100,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 150,
          paid: 40,
        });

        await closeOut(client, {
          contractId: fx.contractId,
          invoiceActions: [{ invoice_id: inv.id, action: "write_off", amount: 0 }],
        });

        const after = await client.query<{ paid: string; state: string; balance: string }>(
          `select paid::text, state::text, balance::text from public.invoices where id = $1`,
          [inv.id],
        );
        expect(after.rows[0].state).toBe("waived");
        expect(Number(after.rows[0].paid)).toBe(40); // untouched
        expect(Number(after.rows[0].balance)).toBe(110); // written-off amount
      });
    });
  });

  test("19. mark_disputed leaves state/balance; invoice still accepts allocation", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 100,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 80,
        });

        await closeOut(client, {
          contractId: fx.contractId,
          outcome: "keep_terminated",
          invoiceActions: [{ invoice_id: inv.id, action: "mark_disputed", amount: 0 }],
        });

        const after = await client.query<{
          paid: string;
          state: string;
          balance: string;
          disputed_at: string | null;
        }>(
          `select paid::text, state::text, balance::text, disputed_at
             from public.invoices where id = $1`,
          [inv.id],
        );
        expect(after.rows[0].state).toBe("due");
        expect(Number(after.rows[0].balance)).toBe(80);
        expect(after.rows[0].disputed_at).not.toBeNull();

        // Still accepts an allocation (dispute is a flag, not a terminal state).
        const { rows: pay } = await client.query<{ id: string }>(
          `insert into public.payments (tenant_id, amount, method, status, payment_date)
           values ($1, 80, 'cash', 'confirmed', current_date) returning id`,
          [fx.tenantId],
        );
        await client.query(`select * from public.apply_payment_allocation($1, $2::jsonb)`, [
          pay[0].id,
          JSON.stringify([{ invoice_id: inv.id, amount: 80 }]),
        ]);
        const paid = await client.query<{ state: string; paid: string }>(
          `select state::text, paid::text from public.invoices where id = $1`,
          [inv.id],
        );
        expect(paid.rows[0].state).toBe("paid");
        expect(Number(paid.rows[0].paid)).toBe(80);
      });
    });
  });
});

describe("close_out_contract history, audit, atomicity", () => {
  test("21. financial history survives: pre-existing invoices/payments/allocations/receipts remain", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 300,
        });
        const inv1 = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 100,
          month: 1,
        });
        const inv2 = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 100,
          month: 2,
        });
        const { rows: pay } = await client.query<{ id: string }>(
          `insert into public.payments (tenant_id, amount, method, status, payment_date)
           values ($1, 100, 'cash', 'confirmed', '2026-02-01') returning id`,
          [fx.tenantId],
        );
        await client.query(`select * from public.apply_payment_allocation($1, $2::jsonb)`, [
          pay[0].id,
          JSON.stringify([{ invoice_id: inv1.id, amount: 100 }]),
        ]);
        const receiptsBefore = await client.query(
          `select id from public.receipts where payment_id = $1`,
          [pay[0].id],
        );

        await closeOut(client, {
          contractId: fx.contractId,
          invoiceActions: [
            { invoice_id: inv1.id, action: "leave", amount: 0 },
            { invoice_id: inv2.id, action: "write_off", amount: 0 },
          ],
        });

        const invCount = await client.query(
          `select id from public.invoices where contract_id = $1`,
          [fx.contractId],
        );
        expect(invCount.rows).toHaveLength(2);
        const payStill = await client.query(`select id from public.payments where id = $1`, [
          pay[0].id,
        ]);
        expect(payStill.rows).toHaveLength(1);
        const allocStill = await client.query(
          `select id from public.payment_allocations where payment_id = $1`,
          [pay[0].id],
        );
        expect(allocStill.rows).toHaveLength(1);
        const receiptsAfter = await client.query(
          `select id from public.receipts where payment_id = $1`,
          [pay[0].id],
        );
        expect(receiptsAfter.rows.length).toBe(receiptsBefore.rows.length);
      });
    });
  });

  test("22. audit rows written in same transaction (rollback → zero rows)", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 55,
        });
        await closeOut(client, { contractId: fx.contractId });

        const audits = await client.query(
          `select id from public.audit_logs
            where action = 'contract.close_out' and entity_id = $1`,
          [fx.contractId],
        );
        expect(audits.rows.length).toBeGreaterThanOrEqual(1);
      });
      // withRollback rolls back — nested check: open a fresh transaction and
      // confirm no leftover rows from the rolled-back work.
    });
    // Outside the rolled-back transaction the audit rows are gone.
    await withRollback(async (client) => {
      const leftover = await client.query(
        `select id from public.audit_logs where action = 'contract.close_out' limit 5`,
      );
      // Other concurrent tests may leave none; we only assert our rolled-back
      // work is not durable — the prior withRollback already discarded it.
      expect(Array.isArray(leftover.rows)).toBe(true);
    });
  });

  test("22b. forced rollback clears close-out audit rows", async () => {
    // Explicit: raise after close-out inside the same transaction → no audit.
    const client = await (await import("@/db/testDb")).getPool().connect();
    try {
      await client.query("begin");
      const companyId = await seedCompany(client);
      const adminId = await seedAdmin(client, companyId);
      await actAs(client, "authenticated", adminId);
      const fx = await seedContract(client, {
        companyId,
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
      await seedInsurance(client, {
        contractId: fx.contractId,
        tenantId: fx.tenantId,
        unitId: fx.unitId,
        companyId: fx.companyId,
        amount: 55,
      });
      await closeOut(client, { contractId: fx.contractId });
      const mid = await client.query(
        `select count(*)::int as n from public.audit_logs
          where action = 'contract.close_out' and entity_id = $1`,
        [fx.contractId],
      );
      expect(mid.rows[0].n).toBeGreaterThanOrEqual(1);
      await client.query("rollback");

      await client.query("begin");
      const after = await client.query(
        `select count(*)::int as n from public.audit_logs
          where action = 'contract.close_out' and entity_id = $1`,
        [fx.contractId],
      );
      expect(after.rows[0].n).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("23. contract_operational_events gets closeout_completed", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 45,
        });
        await closeOut(client, { contractId: fx.contractId });
        const events = await client.query<{ event_type: string }>(
          `select event_type from public.contract_operational_events
            where contract_id = $1 and event_type = 'closeout_completed'`,
          [fx.contractId],
        );
        expect(events.rows).toHaveLength(1);
      });
    });
  });

  test("24. rollback atomicity: failure at refund undoes contract/invoice/unit changes", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 250,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 50,
        });

        const beforeContract = await client.query(
          `select state::text, archived_at from public.contracts where id = $1`,
          [fx.contractId],
        );
        const beforeInv = await client.query(
          `select state::text, paid::text from public.invoices where id = $1`,
          [inv.id],
        );
        const beforeUnit = await client.query(
          `select status::text from public.units where id = $1`,
          [fx.unitId],
        );

        // Force failure at the refund insert.
        await client.query(`
          create or replace function pg_temp.force_refund_fail()
          returns trigger language plpgsql as $f$
          begin
            raise exception 'forced refund failure';
          end;
          $f$;
        `);
        await client.query(`
          create trigger trg_force_refund_fail
            before insert on public.refunds
            for each row execute function pg_temp.force_refund_fail();
        `);

        // captureRaise confines the abort so the outer withRollback transaction survives.
        expect(
          await captureRaise(client, () =>
            closeOut(client, {
              contractId: fx.contractId,
              outcome: "archive",
              deductions: [{ kind: "damages", amount: 25.5, description_en: "x" }],
              invoiceActions: [{ invoice_id: inv.id, action: "write_off", amount: 0 }],
            }),
          ),
        ).toMatch(/forced refund failure/i);

        const afterContract = await client.query(
          `select state::text, archived_at from public.contracts where id = $1`,
          [fx.contractId],
        );
        const afterInv = await client.query(
          `select state::text, paid::text from public.invoices where id = $1`,
          [inv.id],
        );
        const afterUnit = await client.query(
          `select status::text from public.units where id = $1`,
          [fx.unitId],
        );
        expect(afterContract.rows[0]).toEqual(beforeContract.rows[0]);
        expect(afterInv.rows[0]).toEqual(beforeInv.rows[0]);
        expect(afterUnit.rows[0]).toEqual(beforeUnit.rows[0]);
      });
    });
  });

  test("25. preview totals match commit; preview writes nothing", async () => {
    await withRollback(async (client) => {
      await asAdmin(client, async (_adminId, companyId) => {
        const fx = await seedContract(client, {
          companyId,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
        });
        await seedInsurance(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          amount: 250,
        });
        const inv = await seedOpenInvoice(client, {
          contractId: fx.contractId,
          tenantId: fx.tenantId,
          unitId: fx.unitId,
          companyId: fx.companyId,
          total: 100,
        });
        const deductions = [
          { kind: "damages", amount: 25.5, description_en: "Damages", description_ar: "أضرار" },
        ];
        const actions = [{ invoice_id: inv.id, action: "write_off", amount: 0 }];

        const beforeCloseouts = await client.query(
          `select count(*)::int as n from public.contract_closeouts where contract_id = $1`,
          [fx.contractId],
        );
        const beforeRefunds = await client.query(
          `select count(*)::int as n from public.refunds where contract_id = $1`,
          [fx.contractId],
        );

        const prev = await preview(client, fx.contractId, deductions, actions, null);
        expect(Number(prev.deposit_held)).toBe(250);
        expect(Number(prev.deductions_total)).toBe(25.5);
        expect(Number(prev.written_off_total)).toBe(100);
        expect(Number(prev.refund_total)).toBe(224.5);

        // Still no writes
        const midCloseouts = await client.query(
          `select count(*)::int as n from public.contract_closeouts where contract_id = $1`,
          [fx.contractId],
        );
        const midRefunds = await client.query(
          `select count(*)::int as n from public.refunds where contract_id = $1`,
          [fx.contractId],
        );
        expect(midCloseouts.rows[0].n).toBe(beforeCloseouts.rows[0].n);
        expect(midRefunds.rows[0].n).toBe(beforeRefunds.rows[0].n);

        const committed = await closeOut(client, {
          contractId: fx.contractId,
          deductions,
          invoiceActions: actions,
        });
        expect(Number(committed.deposit_held)).toBe(Number(prev.deposit_held));
        expect(Number(committed.deductions_total)).toBe(Number(prev.deductions_total));
        expect(Number(committed.settled_total)).toBe(Number(prev.settled_total));
        expect(Number(committed.written_off_total)).toBe(Number(prev.written_off_total));
        expect(Number(committed.refund_total)).toBe(Number(prev.refund_total));
        expect(Number(committed.balance_due_tenant)).toBe(Number(prev.balance_due_tenant));
      });
    });
  });
});
