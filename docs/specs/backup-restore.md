# Specification — Backup & Restore (admin settings)

Revision 2 — rewritten after Codex round 1 rejected revision 1 with fourteen
blocking objections. Where an objection was accepted the section says so; where
it was accepted only in part, the residual risk is stated rather than hidden.

Branch: `feat/settings-backup-restore`.

## 1. Goal

Give an administrator a self-service way to snapshot the entire application
database into a single compressed archive, keep several such archives, download
or delete any of them, restore one, and have the system take the snapshot on its
own every day or every week.

The user-visible outcome: a **Backup** tab at `/admin/settings/backup` with a
large, colourful, tooltip-annotated UI, and an automatic backup that runs
unattended.

## 2. Scope, and what this feature is not

### In scope

- Consistent logical export of every base table in `public` to JSON, packed into
  one compressed ZIP.
- Storage of that ZIP in a **private** `backups` bucket.
- A `backups` metadata table indexing every archive.
- Admin UI: back up now, list, download, delete, restore.
- Restore: wipe-and-replace, in one locked transaction, refusing to run against
  a schema that has drifted.
- Two mutually exclusive auto-backup switches — daily and weekly — driving one
  idempotent cron job.
- Retention pruning.
- Arabic + English strings for every new label.

### Out of scope — and the UI must say so out loud

This is a **database** snapshot, not a full system image. Three exclusions have
user-visible consequences, so the UI states each in plain language rather than
letting an admin infer a guarantee that does not exist:

1. **Uploaded files are not archived.** Tenant documents, property images,
   branding assets and generated PDFs stay in their own buckets and a restore
   does not touch them. Consequence, stated in the restore dialog: a restored
   `tenant_documents` row can reference a file that has since been deleted, and
   a file uploaded after the archive was taken will remain on disk with no row
   pointing at it. Rationale for the exclusion: the requirement is explicitly a
   small archive, and binary assets would dominate it. *(Codex objection 6,
   accepted as a disclosure rather than as an object inventory — an inventory
   preflight would refuse restores for a condition the admin cannot fix.)*
2. **The `auth` schema is not archived.** No password hashes, no sessions. See
   §6.5 for the reconciliation this forces.
3. **`audit_logs` is exported but never overwritten.** See §6.6.

Also out of scope: point-in-time recovery, WAL archiving, off-site replication,
partial or selective restore, cross-schema restore.

## 3. Data model

### 3.1 `public.backups`

| column           | type            | notes                                          |
| ---------------- | --------------- | ---------------------------------------------- |
| `id`             | uuid pk         | `gen_random_uuid()`                            |
| `file_name`      | text not null   | human-friendly, e.g. `backup-2026-08-17-0312.zip` |
| `storage_path`   | text not null unique | `backups/<uuid>.zip` — a **uuid**, never the timestamp |
| `sha256`         | text not null   | hex digest of the archive bytes                |
| `size_bytes`     | bigint not null |                                                |
| `table_count`    | int not null    |                                                |
| `row_count`      | bigint not null |                                                |
| `kind`           | text not null   | `manual` \| `automatic` \| `pre_restore`       |
| `period_key`     | text null       | set for `automatic` only — see §7.2            |
| `note`           | text null       |                                                |
| `created_by`     | uuid null       | null for cron                                  |
| `created_at`     | timestamptz     | `now()`                                        |

- `unique (kind, period_key) where period_key is not null` — the **final**
  authority on auto-backup idempotency. Two ticks racing each other both pass
  the "is it due?" read; only one survives the insert. *(Objection 11.)*
- `storage_path` carries a uuid because a minute-resolution filename collides
  when two runs start in the same minute. The friendly timestamp stays in
  `file_name`, which is what the admin sees and downloads as. *(Objection 11.)*
- `sha256` is verified before a restore. The bucket is service-role-only, so
  this is defence in depth — but an operation that deletes every row should not
  treat "the ZIP parsed" as proof it is the archive we wrote. *(Objection 6
  non-blocking.)*

**Privileges.** `grant select on public.backups to authenticated`, with RLS
allowing `select` only to admins, plus a `service_role` all-policy. Revision 1
revoked everything from `authenticated` *and* wrote an admin select policy,
which cannot work: RLS filters a grant, it cannot substitute for one.
*(Objection 2 non-blocking.)* No insert/update/delete grant for `authenticated`
at all — every write goes through a server function holding the service key.

### 3.2 `backups` storage bucket

Private, `service_role`-only policy, modelled on migration 109. The browser
never receives a bucket credential; it receives a 60-second signed URL and does
read Storage directly with it. *(Objection 3 non-blocking — revision 1 claimed
the browser never touches Storage, which was simply false.)*

Copy this bucket only with `rsync -aX` or `tar --xattrs`: Supabase Storage keeps
content type in POSIX extended attributes and a plain copy makes every object
return HTTP 500 `ENODATA`.

### 3.3 Company columns

`companies.backup_daily_enabled` and `companies.backup_weekly_enabled`, both
`not null default false`, with a check constraint forbidding both true at once.

The backup itself is global and has no `company_id`. The switches live on
`companies` because that is where every other global setting in this product
lives and the deployment is single-company; the job reads the **oldest**
`companies` row by `created_at` and the migration documents that singleton
assumption explicitly, so a future second company is a loud design decision
rather than a silent misread. *(Objection 5 non-blocking, accepted as a
documented invariant rather than a new settings table.)*

## 4. Database functions

All `security definer`, `set search_path = public, pg_temp`, and — mandatory —
`revoke execute … from public, anon, authenticated` then `grant execute … to
service_role`. Revoking from `public` alone leaves the grants `anon` and
`authenticated` hold in their own right; a dump RPC reachable by `anon` is a
full-database read for the internet. `src/db/anonExecute.sqltest.ts` already
fails the suite if this is got wrong.

| function | returns | purpose |
| -------- | ------- | ------- |
| `backup_excluded_tables()` | `setof text` | tables never dumped |
| `backup_protected_tables()` | `setof text` | tables never deleted on restore |
| `backup_table_names()` | `setof text` | base tables in `public`, minus the exclusions |
| `backup_schema_fingerprint()` | `text` | sha256 over the shape of every dumped table |
| `backup_dump_all()` | `jsonb` | **one call, one snapshot** — the whole archive payload |
| `backup_restore(_payload jsonb, _actor uuid)` | `jsonb` | locked wipe-and-replace, returns a report |

### 4.1 One call, one snapshot

`backup_dump_all()` replaces revision 1's per-table `backup_dump_table()`.
Revision 1 called one RPC per table; each PostgREST request is its own
transaction with its own snapshot, so a payment could be written between the
`invoices` dump and the `payments` dump and the archive would contain an invoice
with no payment — an archive that is not a snapshot of any state the database
was ever in. A single function body sees a single snapshot. *(Objection 1,
accepted in full.)*

It returns `{ format_version, schema_fingerprint, captured_at, tables: [{ name,
rows }] }` — `tables` is an **array**, which is the one shape both this function
and `backup_restore` speak — and raises if the total payload exceeds a
configured ceiling, so an unexpectedly large database fails loudly instead of
exhausting server memory.

This is viable precisely because the database is small: the whole `public`
schema measures about 7 MB on production, the largest table being
`gmail_messages` at 3 MB. Measured, not assumed. The ceiling is the guard that
keeps the assumption honest as it grows.

**The function must be declared `STABLE`.** "One function body, one snapshot" is
false for a `VOLATILE` function: under `READ COMMITTED` every *statement* takes
a fresh snapshot, and a volatile PL/pgSQL function's internal queries are
separate statements — so the per-table loop would take a new snapshot per table
and reintroduce exactly the cross-table tear this single-call design exists to
remove. `STABLE` pins all of its queries to the calling statement's snapshot.
`captured_at` uses `statement_timestamp()` for the same reason;
`clock_timestamp()` is volatile and would contradict the guarantee.
*(Round 2, objection 1.)*

### 4.2 Exclusions are two different lists

- **`backup_excluded_tables()`** — not dumped: `backups` itself. Restoring it
  would delete the row describing the archive being restored and the
  pre-restore safety archive, leaving files on disk with no index of them.
- **`backup_protected_tables()`** — dumped, but never deleted or replaced on
  restore: `audit_logs`. See §6.6.

Revision 1 had one list for both, which is how `audit_logs` came to be wiped.
*(Objection 7.)*

## 5. Archive format

```
backup-<YYYY-MM-DD>-<HHmm>.zip
├── manifest.json
└── tables/<name>.json          (one per table, minified)
```

```json
{
  "format_version": 1,
  "schema_fingerprint": "9f2c…",
  "created_at": "2026-08-17T03:12:44.000Z",
  "kind": "manual",
  "tables": [{ "name": "contracts", "rows": 41 }],
  "row_count": 2130
}
```

- Minified JSON, `fflate.zipSync` level 9. `fflate` is a direct dependency and
  is pure ESM; `jszip` is present in `package.json` but is CommonJS, and a
  CommonJS import in `src/fns/*` has previously leaked into a client route chunk
  and broken the page with `Class extends value undefined`.
- `readArchive` rejects: a missing or unparseable manifest, a
  `format_version` above the supported one, a manifest table with no data entry,
  a **duplicate** ZIP entry, a per-table row count disagreeing with the
  manifest, and an uncompressed size above a hard ceiling (a zip bomb guard). An
  unlisted *extra* entry is ignored, keeping the format additive.
- `sha256` of the archive bytes is stored on the row at creation and re-verified
  before restore.

## 6. Restore semantics

### 6.1 Locked, fingerprint-gated wipe-and-replace

In one transaction, in this order:

1. Verify `format_version` — a property of the payload, checkable before
   anything else.
2. Verify the payload is **complete**: exactly one entry for every table in
   `backup_table_names()`, protected tables included, with no missing, extra or
   duplicated names. The fingerprint hashes the *schema*, so it cannot notice
   that the *payload* omits a table — and an omitted table is simply left at its
   current contents, producing a hybrid database that is neither the archive nor
   the present. *(Round 2, objection 2.)*
   Mismatch ⇒ raise and roll back, having touched nothing. This is what makes
   the "return the database to the archived state" claim true: revision 1 would
   silently skip a table added since the archive, leave it at its current state,
   and never mention it, producing a hybrid database that is neither the archive
   nor the present. Restoring across a schema change now requires deliberate
   work, not luck. *(Objection 3, accepted in full.)*
3. `lock table … in access exclusive mode` on every affected table, in a
   deterministic (alphabetical) order to avoid deadlocks. `session_replication_role`
   suppresses constraint checks, not concurrent writers; without these locks an
   ordinary application transaction can insert between a table's `delete` and
   its re-population. Alphabetical ordering matters: two lockers taking the same
   locks in different orders deadlock. *(Objection 2, accepted in part — see the
   residual risk below.)*
4. Verify `schema_fingerprint` equals `backup_schema_fingerprint()` **now**.
   This runs **after** the locks and before any delete: checking it first would
   leave a window in which a concurrent migration alters the schema between the
   check and the lock. The fingerprint is built from the catalogs
   (`format_type`, `attnotnull`, `attidentity`, `attgenerated`, and
   `pg_get_constraintdef` per constraint), not from `information_schema`'s
   `data_type`, which reports plain `numeric` for `numeric(12,3)` and `ARRAY`
   for every array type and would let a precision change slip through.
   *(Round 2, objection 4.)*
5. `set local session_replication_role = replica` — `local`, so it reverts with
   the transaction even on error.
6. For each dumped, non-protected table: `delete`, then insert.
7. Verify, per table, that **`inserted + skipped == the manifest count`**, and
   that no row inserted into an auth-linked column points at a missing
   `auth.users` row. Any mismatch raises and rolls the whole restore back.
   Re-enabling enforcement does **not** re-validate rows inserted while it was
   off, so this check is the only thing standing between a suppressed constraint
   and a silently inconsistent database. *(Objection 8, accepted as explicit
   verification rather than as staging tables.)*

   The orphan check covers **every** foreign key whose enforcement was
   suspended, not only those pointing at `auth.users`. `replica` mode disables
   all of them, and re-enabling it re-validates nothing. When a `profiles` row is
   skipped, rows in tables that reference `profiles` — `messages.sender_profile_id`
   and `invoice_years.created_by` among them — would insert pointing at a profile
   that no longer exists. So the check loops `pg_constraint` over the restored
   tables and rolls back on the first dangling reference, naming the constraint.
   *(Round 2, objection 3.)*

   A **composite** foreign key raises "unsupported" rather than being skipped.
   There are none in `public` today (verified: zero, on production), so the
   guard is dormant. It was called a delayed landmine on the grounds that adding
   one later would suddenly make restores fail — but that reads the trade
   backwards. The alternative is a restore that silently stops validating a
   constraint class while enforcement is suspended, which is how a restore
   quietly produces a broken database. For an operation that deletes every row,
   failing loudly on a case the code has not been taught to check is the correct
   behaviour, and the exception names exactly what to implement.

   The exact form of that invariant matters, and the obvious wording of it is
   wrong. "Inserted equals the manifest count" fails **every** restore on **every
   real database**, for two independent reasons: `audit_logs` is protected, so its
   manifest count is N and its inserted count is 0 by design; and a row skipped
   under a cascade FK to `auth.users`, or kept with a nullable actor column set to
   null, is likewise a deliberate difference. So the check is
   `inserted + skipped == manifest`, evaluated only over the **restored set** —
   the tables in `manifest ∩ backup_table_names() ∖ backup_protected_tables()`.
   Protected tables are asserted untouched instead.
8. Re-assert the actor (§6.4).

**Residual risk, stated rather than engineered away.** The safety archive of
§6.2 is taken in a transaction that commits before the restore transaction
begins, so a write landing in the seconds between the two is destroyed by the
restore without appearing in the safety copy. Closing that window entirely means
a database-enforced application-wide write freeze, which is a much larger
feature than this one and would need a way to unfreeze after a crash. The window
is seconds, the restore is a deliberate act by the one admin performing it, and
this product has a handful of concurrent staff users. Accepted, documented here
and in the restore dialog.

### 6.2 A safety archive is taken first, and cannot be pruned away

Order of operations, which revision 1 had wrong:

1. Download the selected archive, verify its sha256, unpack and validate it —
   **before** anything is created or deleted. Revision 1 created the safety
   backup first, which could trigger retention pruning that deleted the very
   archive about to be restored. *(Objection 9.)*
2. Create a `pre_restore` archive. If this fails, abort — the one operation that
   destroys data gets the one thing that makes destruction survivable.
3. Restore.

Retention never prunes a `pre_restore` archive as part of the ordinary pass, and
no pruning runs at all during a restore. `pre_restore` archives are pruned by
their own, longer allowance.

### 6.3 Foreign keys to `auth.users` are handled per constraint, not as a class

Revision 1 said "skip any row whose FK targets `auth.users`". That is wrong and
would have destroyed business records: this schema has *nullable* actor columns
on payments, expenses, deposits and documents, and dropping a payment because
the staff member who recorded it has since been deleted is data loss dressed up
as integrity. *(Objection 4, accepted in full.)*

Each FK to `auth.users` is handled by its actual `confdeltype`, read from
`pg_constraint` rather than hardcoded:

| constraint | behaviour |
| ---------- | --------- |
| nullable, `on delete set null` | keep the row, set that column null — reproducing what the live database would itself have done |
| `on delete cascade` | skip the row (that is the semantics the schema declares) |
| `not null`, no action / restrict | skip the row and count it — inserting it would be an unenforceable dangling reference |

Every skip is counted per table and per column and reported. Tests cover every
direct FK to `auth.users` in the schema, not just `profiles`.

### 6.4 The acting admin is never locked out

`backup_restore` takes the acting admin's uuid and, last, re-asserts their
`profiles` row and their `admin` entry in `user_roles` whether or not the
archive contained them. Without it, restoring an archive predating the current
admin's account logs them out of the application that just restored — the
lockout `erase_all_data` already guards against.

### 6.5 Everyone else created after the archive is reported, not silently stripped

`auth.users` stays current while `profiles`, `user_roles` and friends revert. A
staff member or tenant created after the archive therefore keeps a login and
loses their application identity. This is inherent to restoring an old snapshot;
refusing the restore outright would make the feature unusable, and doing it
silently is unacceptable. So:

- A **preflight** counts current `auth.users` with no matching profile in the
  archive and shows that count, with names, in the confirmation dialog *before*
  the admin confirms.
- The restore result repeats it.

*(Objection 5, accepted as mandatory disclosure.)*

### 6.6 The audit trail survives the restore, and records it

`audit_logs` is dumped into the archive but is **never** deleted or replaced by
a restore. Wiping it would erase the evidence of everything done since the
archive — including the evidence surrounding the restore itself — and this
database's own `erase_all_data` already preserves it during a destructive reset.
*(Objection 7, accepted in full.)*

Backup creation, download, deletion, restore request, restore success and
restore failure each write an audit row through the existing `write_audit`
helper.

The **success** row is written as the final statement *inside* `backup_restore`,
so it commits atomically with the restored data. Revision 2 put it in the caller
after the RPC returned, which meant a failed audit write left a destructive
restore with no record of it — the one case where the audit row matters most.
Inside the transaction it is written or rolled back with the restore itself.
Request-time and failure auditing stay in the caller, where they belong: a
rolled-back restore must still leave evidence that it was attempted.
*(Round 2, objection 6.)*

### 6.7 Result shape

```json
{
  "tables": [{ "name": "payments", "deleted": 88, "inserted": 88, "skipped": 0, "nulled": 2 }],
  "skipped_by_table": { "profiles": 1 },
  "orphan_logins": 3,
  "restored_at": "…"
}
```

A restore that "worked" while skipping rows or nulling columns must say so.

## 7. Automation

### 7.1 One job, frequency in the database

One entry keyed `backup` in the `JOBS` map of `src/fns/cronJobs.ts`. Not two
jobs: `/etc/cron.d/danat-ermp` is root-owned and fixed, so the switches can only
mean something if frequency is database state the job reads.

Wiring the job takes **four** things, not one — revision 1 listed only the first
and would have shipped a Run-now button that throws *"No run permission
configured"* and a job whose runs are never recorded. *(Objection 13.)*

1. `backup: runBackupJob` in the `JOBS` map.
2. A `backup` entry in `WORKFLOW_CATALOG` (`kind: "scheduled"`, its deployed
   `schedule` string, and an **admin-only** `runPermission` — not a broad staff
   permission; this job can be made to write a full copy of the database).
3. A migration-seeded `cron_jobs` row with both locales, or the Workflows screen
   neither lists it nor records its runs.
4. A parity test asserting the three registries agree.

### 7.2 Due rules keyed to Kuwait calendar periods

`period_key` is derived from the Kuwait wall clock:

| mode | `period_key` | example |
| ---- | ------------ | ------- |
| daily | `d:YYYY-MM-DD` | `d:2026-08-17` |
| weekly | `w:YYYY-Www` (Kuwait ISO week) | `w:2026-W34` |

The job computes today's key, and the unique index on `(kind, period_key)`
decides. Revision 1 compared elapsed time — "newer than 7 days" — which drifts:
a Monday run inserting its row five seconds after the tick makes the next
Monday's tick five seconds short of seven days, so it skips to Tuesday and the
weekly backup walks through the week. Calendar periods do not drift.
*(Objection 12.)*

Switching daily ↔ weekly mid-period: the new mode's key has never been used, so
the next tick backs up immediately. That is the safe direction — an extra
archive, never a missed one — and it is stated in the UI.

Neither switch on ⇒ the job returns `{ skipped: "disabled" }` and creates
nothing.

A `pg_advisory_xact_lock` around the job body keeps two ticks from doing the
duplicated *work*; the unique constraint is what guarantees the duplicated *row*
cannot exist. Both, because the lock is an optimisation and the constraint is
the invariant.

### 7.3 Retention

Keep the newest **10** archives — a fixed constant, not a setting, and named as
such in the UI so no one goes looking for a control that does not exist.
*(Objection 4 non-blocking.)* `pre_restore` archives are excluded from that
count and pruned under their own allowance of 5.

Deletion order: **the metadata row first, then the storage object.** Revision 1
had this backwards and justified it with the failure mode it actually causes —
deleting the object first and then failing leaves a row pointing at a missing
file, which is a download button that 500s. Row-first leaves an orphaned file:
invisible, harmless, and findable. *(Objection 10 — Codex was right and the
original rationale was self-contradictory.)*

Pruning failures are logged and swallowed: a retention hiccup must not make a
successful backup report failure.

### 7.4 The crontab entry is part of the deliverable

`50 1 * * * root /usr/local/bin/danat-cron backup` added to
`/etc/cron.d/danat-ermp` over `ssh-danatfuture-mcp` — 01:50 UTC, after the
existing 01:40 notification-drain, so the archive captures the night's work. The
host runs UTC; the due rules are evaluated in Kuwait time, which is why they are
computed in the application and not from the crontab.

Installed **after** the deploy that contains the job, never before: a crontab
line naming a job the running code does not know returns HTTP 400 every night.

## 8. Server functions (`src/fns/`)

`createBackup`, `listBackups`, `downloadBackupUrl`, `deleteBackup`,
`restoreBackup`, `runBackupJob`.

- **Never `throw new Response(403)`.** A thrown `Response` resolves *client-side
  as success* through `x-tss-raw`; `eraseAllData` does this today and its caller
  cannot distinguish a refusal from a success. Throw `Error`, return explicit
  `{ ok: true, … }`.
- Zod schemas are **exported** and asserted directly — the project's
  `createServerFn` test mock skips `.validator()`, so a schema wired only into
  the server function is never exercised.
- Backup list and download responses set `Cache-Control: no-store`.

## 9. UI

New **Backup** tab, route `/admin/settings/backup`, admin-only, split across a
route shell + four cards + a hook so no file approaches the 500–600 line
ceiling.

Large gradient-accented cards, oversized headings and numerals, big icon
buttons, a tooltip on every action, hover detail on every archive row. RTL-correct
in Arabic; logical spacing utilities, never left/right. Destructive actions
visually separated from safe ones.

The restore dialog states, before the admin types `RESTORE`: what is replaced,
that everything created since is lost, that a safety copy is taken first, that
uploaded files are not part of the archive, and the preflight count of logins
that will lose their application identity.

## 10. Verification

- `bun run lint`, `typecheck` and `test` green.
- `bun run test:sql` at **403/407**. The four failures are pre-existing on
  `main` and unrelated to this feature — `anonExecute` ×2 and `profiles.is_active`
  ×2 — proven by rebuilding the database with migration 146 removed entirely and
  observing the identical four. Stating "green" here would have been false, and
  a gate that is quietly not green stops being a gate.
- `bun run build` compared against the pre-change baseline — 225 client chunks,
  of which exactly two (`jszip.min.js`, `TenantDocumentsManager.js`) carry ZIP
  code. A third, especially an `admin.settings.backup` chunk, means the
  server-only archive builder leaked into the browser. No unit test can see this.
- SQL suite: dump/restore round trip; the `invoices` round trip specifically
  (its `balance` column is `GENERATED ALWAYS`, so a blind `insert … select *`
  fails — the insert must name its columns, derived from
  `information_schema.columns`); fingerprint mismatch refusing before any
  delete; each `auth.users` FK behaviour; `audit_logs` surviving; the actor
  keeping admin; the unique `(kind, period_key)` rejecting a second automatic
  backup in one period; neither `anon` NOR `authenticated` able to execute any of the new functions — the grants are revoked from both, so testing only `anon` would leave half the contract unverified.
  *(No sequence in `public` is owned by a table column — every key is a uuid — so
  no sequence resynchronisation is needed. Verified on the live database.)*
- Guards: `clean-code-guard`, `test-guard`, `docs-guard`.
