import { afterAll, describe, expect, test } from "vitest";

import { closePool, withRollback } from "@/db/testDb";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";

afterAll(closePool);

/**
 * Migration 69 — one registry serving both the jobs the cron endpoint
 * dispatches and the workflows an application event fires, told apart by
 * `kind`.
 *
 * The table keeps the name `cron_jobs` deliberately; see the migration header.
 */

/**
 * Every event workflow, exhaustively.
 *
 * This list stays exhaustive on purpose, unlike the scoped per-migration checks
 * elsewhere: an event sender that ships without a registry row has no switch and
 * no run history, and is invisible on the Workflows tab. Failing here is how the
 * next one gets noticed. Add the key when you add the sender.
 *
 * Migration 69 seeded the first four — senders that until then fired with no
 * row, no switch, no history. Migration 72 added the last five.
 */
const EVENT_KEYS = [
  "contact-inquiry-received",
  "contract-closeout-completed",
  "contract-created",
  "contract-ended",
  "contract-restored",
  "deposit-confirmed",
  "invoice-disputed",
  "invoice-written-off",
  "maintenance-request-created",
  "manual-payment-invoice",
  "payment-succeeded",
  "refund-recorded",
  "user-credentials-managerial",
  "user-credentials-tenant",
  "whatsapp-session-disconnected",
];

/** The keys of the JOBS map in src/fns/cronJobs.ts. */
const SCHEDULED_KEYS = [
  // Migration 146 — the nightly database snapshot.
  "backup",
  "contract-expiry",
  "gmail-sync",
  // Migration 242 — daily pruning of audit and notification logs.
  "log-retention",
  "notification-drain",
  "overdue",
  "overdue-reminders",
  "payment-reconcile",
  "salaries",
  "scheduled-reports",
];

/**
 * Per-key seeds from migration 75 / spec §3.2 — day-one targets matching what
 * each sender actually reaches today. Source of truth is the migration; if
 * these diverge from the spec, fix the migration or the spec, not this list.
 */
const SEEDED_RECIPIENT_TARGETS: Record<string, string[]> = {
  "payment-succeeded": ["admin", "company", "tenant"],
  "user-credentials-tenant": ["admin", "company", "tenant"],
  "contract-expiry": ["admin", "company", "tenant"],
  "overdue-reminders": ["tenant"],
  // Migration 146 — the nightly database snapshot. Admin only: it reports on
  // the state of the whole database, which is not a company's business and
  // certainly not a tenant's.
  backup: ["admin"],
  // Everything else is admin+company (explicit seed or column default).
  "user-credentials-managerial": ["admin", "company"],
  "deposit-confirmed": ["admin", "company"],
  "contact-inquiry-received": ["admin", "company"],
  "maintenance-request-created": ["admin", "company"],
  "refund-recorded": ["admin", "company"],
  "contract-created": ["admin", "company"],
  "contract-ended": ["admin", "company"],
  "contract-closeout-completed": ["admin", "company"],
  "contract-restored": ["admin", "company"],
  "invoice-written-off": ["admin", "company"],
  "invoice-disputed": ["admin", "company"],
  "whatsapp-session-disconnected": ["admin", "company"],
  "manual-payment-invoice": ["admin", "company", "tenant"],
  overdue: ["admin", "company"],
  "payment-reconcile": ["admin", "company"],
  "scheduled-reports": ["admin", "company"],
  "notification-drain": ["admin", "company"],
  "gmail-sync": ["admin", "company"],
  salaries: ["admin", "company"],
  // Migration 242 inserts no recipient_targets, so it takes the column default.
  "log-retention": ["admin", "company"],
};

/** Non-empty subsets of {admin, company, tenant} — all legal under the check. */
const VALID_TARGET_COMBINATIONS: string[][] = [
  ["admin"],
  ["company"],
  ["tenant"],
  ["admin", "company"],
  ["admin", "tenant"],
  ["company", "tenant"],
  ["admin", "company", "tenant"],
];

describe("the kind discriminator", () => {
  test("every event workflow is registered as an event", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs where kind = 'event' order by key`,
      );
      expect(rows.map((row) => row.key)).toEqual(EVENT_KEYS);
    });
  });

  test("every cron job classifies itself as scheduled", async () => {
    // The column defaults to 'scheduled', so migration 58's rows need no
    // backfill — this asserts that default actually reached them.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs where kind = 'scheduled' order by key`,
      );
      expect(rows.map((row) => row.key)).toEqual(SCHEDULED_KEYS);
    });
  });

  test("a third kind is rejected", async () => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `insert into public.cron_jobs (key, kind, name_ar, name_en)
             values ('bogus', 'webhook', 'x', 'x')`,
        ),
      ).rejects.toThrow(/cron_jobs_kind_check/);
    });
  });
});

describe("re-running the seed", () => {
  test("does not re-enable a workflow an admin paused", async () => {
    // Migrations get replayed. A replay that silently switched a workflow back
    // on would undo a deliberate admin decision, with no trace.
    await withRollback(async (client) => {
      await client.query(
        `update public.cron_jobs set is_active = false where key = 'deposit-confirmed'`,
      );

      await client.query(
        `insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
           values ('deposit-confirmed', 'event', 'تأكيد الإيداع', 'Deposit confirmed', 'د', 'd')
         on conflict (key) do update
           set kind = excluded.kind,
               name_ar = excluded.name_ar,
               name_en = excluded.name_en,
               description_ar = excluded.description_ar,
               description_en = excluded.description_en`,
      );

      const { rows } = await client.query<{ is_active: boolean }>(
        `select is_active from public.cron_jobs where key = 'deposit-confirmed'`,
      );
      expect(rows[0].is_active).toBe(false);
    });
  });
});

/**
 * Migration 75 — recipient_targets column, check constraint, and per-key seeds.
 * Spec: UNIFIED_WORKFLOWS_AND_RECIPIENT_TARGETS.md §3.1–§3.2, §7.
 */
describe("recipient_targets", () => {
  // One transaction per case, deliberately. Postgres aborts the whole
  // transaction on the first failed statement, so a second expected-failure in
  // the same block reports "current transaction is aborted" and never reaches
  // the constraint — the assertion would be testing the abort, not the check.
  test.each([
    ["an unrecognised target", "array['nobody']::text[]"],
    ["the empty array", "'{}'::text[]"],
  ])("the check constraint rejects %s", async (_label, expression) => {
    await withRollback(async (client) => {
      await expect(
        client.query(
          `update public.cron_jobs
              set recipient_targets = ${expression}
            where key = 'overdue'`,
        ),
      ).rejects.toThrow(/cron_jobs_recipient_targets_check/);
    });
  });

  test("the check constraint accepts every non-empty subset of the allow-list", async () => {
    await withRollback(async (client) => {
      for (const targets of VALID_TARGET_COMBINATIONS) {
        await expect(
          client.query(
            `update public.cron_jobs
                set recipient_targets = $1::text[]
              where key = 'overdue'`,
            [targets],
          ),
        ).resolves.toBeDefined();
      }
    });
  });

  test("every seeded row's targets match migration 75 / spec §3.2", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string; recipient_targets: string[] }>(
        `select key, recipient_targets from public.cron_jobs order by key`,
      );

      const byKey = Object.fromEntries(rows.map((row) => [row.key, row.recipient_targets]));
      expect(Object.keys(byKey).sort()).toEqual(Object.keys(SEEDED_RECIPIENT_TARGETS).sort());

      for (const [key, expected] of Object.entries(SEEDED_RECIPIENT_TARGETS)) {
        expect(byKey[key], key).toEqual(expected);
      }
    });
  });

  test("WORKFLOW_CATALOG keys match the seeded cron_jobs keys (no drift)", async () => {
    // Catalog is what the admin UI and run-now gate know about; the table is
    // what the gate and senders read. They must stay in lockstep.
    await withRollback(async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `select key from public.cron_jobs order by key`,
      );
      const dbKeys = rows.map((row) => row.key);
      const catalogKeys = Object.keys(WORKFLOW_CATALOG).sort();
      expect(dbKeys).toEqual(catalogKeys);
    });
  });
});
