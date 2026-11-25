# Implementation plan — Backup & Restore

Revision 2, matching specification revision 2. Companion to
`docs/specs/backup-restore.md`.

## Step 0 — Baseline (orchestrator, done)

`fflate` added as a direct dependency — pure ESM, unlike the CommonJS `jszip`
already in `package.json`, which has previously leaked from `src/fns/*` into a
client route chunk.

Baseline build recorded: **225 client chunks, exactly two carrying ZIP code**
(`jszip.min.js`, `TenantDocumentsManager.js` — a legitimate client-side download).
The post-implementation build is diffed against that. Noted for honesty: the
baseline was taken immediately *after* `bun add fflate` rather than before, which
is harmless here because nothing imported `fflate` yet, so no chunk could have
changed. *(Codex non-blocking objection 1.)*

## Step 1 — Migration 146 (slice A)

`db/migrations/146_backups.sql`, idempotent, LF-only (a bare `$$` tag under CRLF
makes psql skip statements silently and still exit 0 — use named `$fn$` tags).

1. Table `public.backups` per spec §3.1, including `sha256`, `period_key`, and
   `unique (kind, period_key) where period_key is not null`.
2. `revoke all … from anon, authenticated;` **first** — new public tables arrive
   with everything granted to those roles by Supabase default privileges, and
   revoking from `public` does not touch grants they hold themselves. Then
   `grant select … to authenticated` (RLS filters it to admins) and
   `grant all … to service_role`.
3. Private `backups` bucket + `service_role` policy, modelled on migration 109.
4. `companies.backup_daily_enabled` / `backup_weekly_enabled` + the
   mutual-exclusion check constraint, with the single-company assumption
   documented in SQL.
5. Functions per spec §4: `backup_excluded_tables`, `backup_protected_tables`,
   `backup_table_names`, `backup_schema_fingerprint`, `backup_dump_all`,
   `backup_restore`. Each with
   `revoke execute … from public, anon, authenticated; grant execute … to service_role;`
6. Seed the `cron_jobs` row for `backup` (both locales) — without it the
   Workflows screen neither lists the job nor records its runs.

`backup_restore` must get all of these right, and each corresponds to an
accepted Codex objection:

- fingerprint equality checked **after the locks and before any delete**;
- `lock table … in access exclusive mode` on every affected table in
  alphabetical order (deterministic ordering prevents deadlock);
- `set local session_replication_role = replica`;
- inserts that **name their columns**, derived from
  `information_schema.columns where is_generated <> 'ALWAYS'` —
  `invoices.balance` is `GENERATED ALWAYS` and a blind `insert … select *` fails
  on it;
- per-FK `auth.users` handling driven by `confdeltype` (set-null / skip / skip
  and count), never a blanket skip;
- `audit_logs` dumped but never deleted;
- post-insert count verification and an orphan check, raising and rolling back
  on mismatch;
- the actor's profile and admin role re-asserted last.

## Step 2 — Archive library (slice B)

`src/lib/backupArchive.ts` — pure: `fflate` and standard JS only, no Supabase,
no React. `buildArchive`, `readArchive` (with the duplicate-entry, row-count and
zip-bomb rejections), `backupFileName`, `sha256Hex`, `periodKeyFor`,
`pruneTargets`, `isBackupDue`. Plus `src/lib/backupArchive.test.ts`.

The due rules are **calendar-period** based, not elapsed-time based.

## Step 3 — Server functions (slice C)

`src/fns/backupCore.ts`, `backup.ts`, `restoreBackup.ts`, `backupJob.ts`; the
`JOBS` entry and its idempotency note in `cronJobs.ts`; the `WORKFLOW_CATALOG`
entry with an admin-only `runPermission`; a parity test over
JOBS / WORKFLOW_CATALOG / the seeded `cron_jobs` row.

Restore order: download → verify sha256 → unpack → validate → safety archive →
`backup_restore`. Retention prunes **row first, then object**.

## Step 4 — UI (slice D)

Route shell + `BackupHeroCard` + `AutoBackupCard` + `BackupList` +
`RestoreDialog` + `useBackups`, the settings tab entry, and `settings.backup*`
keys in **both** locales.

The restore dialog carries the disclosures of spec §2 and §6.5 — uploaded files
are not archived, logins created since the archive lose their application
identity (with the preflight count), everything created since is lost.

## Step 5 — Tests

Unit tests alongside slices B and C; the SQL suite in
`src/db/backupRestore.sqltest.ts` covering the list in spec §10. Behavioural
assertions only: a `toMatch(/disabled/)` on a shadcn `Button` is vacuous because
`buttonVariants` bakes `disabled:*` into every render — assert `disabled=""`.

## Step 6 — Guards and gates (orchestrator)

`clean-code-guard` over slices A–D, `test-guard` over the tests, `docs-guard`
over the spec. Then `bun run lint`, `typecheck`, `test`, `test:sql`, and the
build diffed against the Step 0 baseline.

## Step 7 — Review first, then production, in this order

Revision 1 had production changes before review and merged before the review
step ran. Corrected — the ordering is the deliverable here. *(Objection 14.)*

A second review pointed out that revision 2's ordering — "apply the migration,
*then* merge" — is impossible on this topology, and it is right. The migration
file only reaches the server when Dokploy clones `main` at the start of a build;
the server's GitHub token is normally expired between deploys so an arbitrary
feature branch cannot be fetched, and the MCP command-size cap rules out piping
150 KB of SQL in as an argument. There is no way to have the schema in place
before the merge that delivers it. *(Round 2, objection 7.)*

So the merge is the delivery mechanism, and the window is managed rather than
avoided — which is exactly what the runbook in `CLAUDE.md` already describes:

1. Open the PR. CodeRabbit reviews. Apply findings, re-run every gate.
2. `pg_dump` the production database. Schema changes are not reversible.
3. Merge to `main`. Dokploy clones the branch **at the start** of the build, so
   `146_backups.sql` lands in
   `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` minutes
   before the new container swaps in.
4. Immediately apply the migration from that checkout over
   `ssh-danatfuture-mcp`, checksummed against the local file — the checksum is
   what proves production ran the same bytes the SQL suite validated.
5. `notify pgrst, 'reload schema'`, or the new RPCs 404 from a stale cache.
6. Smoke-test: load the Backup tab, create one manual backup, download it,
   confirm the sha256 matches.
7. **Only then** add `50 1 * * * root /usr/local/bin/danat-cron backup` to
   `/etc/cron.d/danat-ermp`. Installed earlier, it calls a job the running code
   does not know and returns HTTP 400 every night.
8. Update `deploy/README.md` with the new crontab line.

**The residual window, stated plainly.** Between the container swapping in at
step 3 and the migration applying at step 4, the new bundle runs against the old
schema. The blast radius is bounded to this feature and nothing else: every new
object is additive, so existing screens are untouched, and the only symptom is
that the new Backup tab errors for the few minutes until step 4 lands. It is
self-healing and affects no money path.

The reviewer's alternative — merge a migration-only PR first, apply it from that
build's checkout, then merge the application code — removes even that window at
the cost of two deploys. It is the right call for a change that alters an
existing table's shape. It is not worth two production deploys for an additive
migration whose worst case is one admin tab erroring briefly.

Rollback: the migration is additive — new table, new bucket, new functions, two
new nullable-defaulted columns — so reverting the deploy leaves the schema
harmlessly ahead of the code. Remove the crontab line first if the job misbehaves.

## Step 8 — Close the goal

The goal closes on the merge — item 3 of step 7 — and is verified by the smoke
test in item 6. Do not stop at the merge: the migration (item 4), the PostgREST
reload (item 5) and the crontab line (item 7) all come after it.
