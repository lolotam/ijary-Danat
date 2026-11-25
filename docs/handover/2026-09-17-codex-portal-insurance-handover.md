# Completed — 2026-09-17

This handover is complete. **Migrations 215 and 216 are already applied to
production. Do not replay the historical deployment steps below.** The original
handover is retained as a record of the starting state.

- PR [#211](https://github.com/lolotam/Dana-kuwait/pull/211) merged as
  `58ef80418f10ccd9592d4b84de638c618a43c500`.
- PR [#214](https://github.com/lolotam/Dana-kuwait/pull/214) merged as
  `1915fdd79e560b24015b0b753fec2197066c1ca5`.
- PR [#212](https://github.com/lolotam/Dana-kuwait/pull/212) merged as
  `3a378397620d5ab251ef8cb6071b66d178c0f78c`.
- Local `main`, remote `main`, and the production checkout agree on the last
  merge. Owner PRs #207 and #208 were not changed.

Implementation was delegated through Cursor with
`cursor-grok-4.6-high-fast`, then independently reviewed and corrected.
Cursor shell failures prevented its validation from completing; the final
checks below were run independently.

All three PRs received clean Codex reviews on their final feature heads:
[#211](https://github.com/lolotam/Dana-kuwait/pull/211#issuecomment-5713882922),
[#214](https://github.com/lolotam/Dana-kuwait/pull/214#issuecomment-5714078809),
[#212](https://github.com/lolotam/Dana-kuwait/pull/212#issuecomment-5714638497).

Final verification: typecheck passed; lint passed with 31 existing warnings and
zero errors; 3,218 unit tests passed with 2 skipped; 709 SQL tests passed across
81 files after rebuilding all 211 migration files. Formatting, code/test/docs
guards, and graph updates completed. Cache refresh regressions were also checked
by removing the invalidation and observing the expected failures.

Final production migration payloads (supersede the old checksums below):

| Migration | Bytes | MD5 | Applied server file |
|---|---:|---|---|
| 215 | 11800 | `349adb51c11469312a57959c109f85dd` | `/root/danat_codex_215_e8a7908.sql` |
| 216 | 12297 | `d6218589cc417a71e5f54833d6057cad` | `/root/danat_216_d6218589.sql` |

Backup 215: `/root/danat_pre_migration_215_20260917.dump` (existing, verified).
Backup 216: `/root/danat_pre_migration_216_20260917_f97a7f3.dump` (fresh, verified).
Both were taken before their respective migration applications.

Production verification included schema reload, RPC existence and grants,
integer-limit audit behavior, settlement payment identity in the close-out
writer, nonnegative insurance totals, and a read-only transaction proving a
tenant can read their own total while another tenant's request is rejected.
No financial actions or notification sends were used as production probes.

The portal nets completed deductions, unreversed settlement payments, and live
linked refunds against collected insurance per contract. Voided/reversed refunds
and reversed settlements restore their portions. Settlement payment IDs are
persisted in the close-out result; migration 216 links uniquely identifiable
legacy payments and refuses ambiguous legacy settlements. Production preflight
found no historical completed settlements requiring backfill.

Final running container: `efbc30ffc401`.
The live site returned HTTP 200. The fetched
`index-CHjP_rSP.js` and `portal.index-B1Nzidzp.js` matched the running
container files by SHA-256; the served artifacts contain the insurance RPC
and portal card. The temporary combined-verification worktree was removed
after its content was confirmed preserved in the published branch.

---

## Historical handover — superseded starting state

# Handover: finish PRs #211, #212, #214

Written 2026-09-17 by the previous agent, whose quota ran out mid-execution.
Everything below is verified against the live repo and the production database
at the moment of writing. Nothing has been applied to production.

---

## 0. State of the world — verified, not assumed

**Production database** (`danatfuture-supabase-ozoxsa-db-1`, via `ssh-danatfuture-mcp`):

```
record_failed_login   = 0   -- migration 215 NOT applied
portal_insurance_total = 0  -- migration 216 NOT applied
failed_login_attempts  = 0  -- migration 215 NOT applied
```

**A pre-migration backup already exists and is fresh — do not take another for 215:**

```
/root/danat_pre_migration_215_20260917.dump   (4.5 MB, pg_dump -Fc, exit 0)
```

Take a *new* dump before migration 216, since 215 will have landed by then.

**Merged and live already** (do not redo): PRs #206, #209, #210, #213.
Migrations 207, 209, 210, 211, 212, 213, 214 are applied and verified.

**Branches and heads:**

| PR | Branch | Head | Review verdict |
|---|---|---|---|
| #211 | `fix/audit-206-followups` | `81efd72` | **GREEN** — "Didn't find any major issues. Swish!" |
| #212 | `feat/portal-insurance-card` | `3a5afbc` | 1 open P1 (below) |
| #214 | `fix/whatsapp-hint-reflects-provider-state` | `98e07e2` | 2 open P1s (below) |

`#207` and `#208` are the owner's own PRs. Leave them alone.

There is a second worktree at `F:\Danat-Mostakbal-206` checked out on
`fix/audit-206-followups`. `F:\Danat-Mostakbal` is the main tree.

---

## 1. Corrections to the runbook you may have been given

The user's runbook names files that **do not exist**. Verified by `test -f`:

| Runbook says | Reality |
|---|---|
| `src/fns/getPortalInsurance.ts` | Does not exist. The logic is `usePortalInsurancePaid` in `src/hooks/usePortalData.ts` plus the `portal_insurance_total` RPC in migration 216. |
| `src/fns/getPortalInsurance.test.ts` | Does not exist. Tests are `src/db/portalInsuranceTotal.sqltest.ts` (on the #212 branch only). |
| `t("invoices.whatsappSent")` | Does not exist. The keys added on the #214 branch are `invoices.sendRefused` and `invoices.sentPartly`. |
| `pg_dump -U postgres` | Must be **`-U supabase_admin`**. |
| "Migration 216 if required" | It is required and already written on the #212 branch. |

`src/components/admin/invoices/InvoicesTable.tsx:230` **is** real — that is the
second call site named in #214's finding.

---

## 2. Operational rules that will bite you

- **Migrations never auto-apply.** Dokploy deploys code only. Apply by hand
  against `danatfuture-supabase-ozoxsa-db-1` **before** merging, because a push
  to `main` auto-deploys within minutes.
- **`ssh-danatfuture-mcp` exec caps at ~1000 characters per command.** A 11 KB
  migration cannot be piped in as an argument.
- **The repo is private**, so the server cannot `curl` a raw GitHub URL, and
  Dokploy's checkout token is expired between deploys, so `git fetch` of a
  feature branch on the server does not work either.
- Two ways to get a migration onto the server, both used successfully in this
  project:
  1. **Chunked base64** — `base64 -w0 file | split -b 900`, send each chunk with
     `printf %s '<chunk>' >> /root/x.b64`, verify the running `md5sum` after
     each, then `base64 -d /root/x.b64 > /root/x.sql` and check the md5 of the
     decoded file against the local one. 18 chunks for migration 215.
  2. **Let the merge deliver it** — `CLAUDE.md` documents this: Dokploy clones
     `main` into
     `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` at the
     *start* of each build, minutes before the container swaps. Merge, then
     immediately apply from that path. This races the container swap; migration
     215 is purely additive and its absence only degrades audit logging (the
     TypeScript caller swallows the error), so the race is survivable — but
     option 1 is what was chosen here.
- **Always `notify pgrst, 'reload schema';`** after applying, or new RPCs 404
  through PostgREST despite existing.
- **Checksum before applying.** It is the only proof production ran the same
  bytes the SQL suite validated.
- `TEST_DB_PORT=55329` for both `bun run test:db` and `bun run test:sql`.
  Port 54329 is Hyper-V reserved and fails with exit 125.
- Docker Desktop on this machine stops without warning. If `docker version`
  returns empty or the named pipe is missing, start
  `C:\Program Files\Docker\Docker\Docker Desktop.exe` and wait ~20 s.
- Run the unit suite as `npx vitest run --exclude '**/.kilo/**'` if `.kilo`
  reappears; PR #213 already added that exclude to `vitest.config.ts` on `main`,
  so a branch rebased on `main` needs no flag. Without it every test runs twice
  (688 files instead of 344).

---

## 3. Reading Codex review verdicts correctly

This cost the previous agent four separate mistakes. **Do not filter review
comments by a guessed timestamp.** Enumerate both endpoints and diff against
what you have already addressed:

```bash
R=lolotam/Dana-kuwait
gh api "repos/$R/pulls/<N>/comments" --jq '.[]|select(.user.login=="chatgpt-codex-connector[bot]")|.created_at'
gh api "repos/$R/issues/<N>/comments" --jq '[.[]|select(.user.login=="chatgpt-codex-connector[bot]")]|.[-1].body'
```

- A round **with findings** posts a review plus inline comments.
- A **clean** round posts only an issue comment reading
  `Codex Review: Didn't find any major issues.` — and sometimes a 👍 reaction on
  the PR. It does **not** appear in `pulls/<N>/reviews`.
- Always confirm the summary table names the **current head SHA**.

Request a new round with a PR comment containing `@codex review`.

---

## PHASE 1 — Migration 215 + merge #211 (ready now, review is green)

Branch `fix/audit-206-followups`, head `81efd72`. Work from
`F:\Danat-Mostakbal-206`.

**What it does:** throttles failed-login audit writes so an unauthenticated
endpoint cannot grow the append-only `audit_logs` table without bound, and
decouples the tenant credential email from its administrative copy.

### 1.1 Backup
Already taken: `/root/danat_pre_migration_215_20260917.dump`. Skip.

### 1.2 Transfer and verify

```
local file: db/migrations/215_throttle_failed_login_audit.sql
size:       11479 bytes
md5:        75382ac6909399fb254249fdd9fba9d8
```

Transfer by chunked base64 (section 2). After decoding on the server, the
md5 of the decoded `.sql` **must** equal `75382ac6909399fb254249fdd9fba9d8`.
Do not apply otherwise.

### 1.3 Apply

```bash
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/215.sql
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

`drop ... if exists` emits NOTICE lines; those are not errors. Grep for `^ERROR`
and trust the exit code.

### 1.4 Verify

```sql
select public.failed_login_is_milestone(1);   -- expect t
select public.failed_login_is_milestone(2);   -- expect f
select count(*) from pg_proc where proname='record_failed_login';          -- expect 1
select count(*) from information_schema.tables where table_name='failed_login_attempts';  -- expect 1
```

### 1.5 Merge

```bash
gh pr merge 211 --merge --delete-branch
```

Then watch for the container swap and confirm the site serves:

```bash
docker ps --filter name=danatfuture-danatfuture --format '{{.Names}}|{{.Status}}'
curl -s -o /dev/null -w '%{http_code}' https://danat-future.com/
```

---

## PHASE 2 — Resolve #212's open P1, then migration 216 + merge

Branch `feat/portal-insurance-card`, head `3a5afbc`, in `F:\Danat-Mostakbal`.

**What the PR does:** replaces the portal dashboard's "Outstanding balance" card
with "Insurance paid", sourced from `insurance_payments` through a new
aggregate-only RPC.

### The open P1 (posted 2026-09-16T13:02:51Z)

> **Stop reporting disposed close-out deposits as held.** When
> `close_out_contract` uses the default `keep_terminated` outcome, it can refund,
> deduct, or apply the deposit while leaving both the `insurance_payments` row
> and an unarchived terminated contract in place
> (`db/migrations/114_closeout_multi_unit.sql:441-480`); the portal contract
> switcher includes such ended contracts (`src/hooks/usePortalData.ts:310-337`).
> This unconditional sum therefore continues to display the original deposit as
> "Insurance held by the office" after it has been disposed during close-out.
> The completed `contract_closeouts` row already records `refund_id`,
> `deductions_total`, and `settled_total`, so exclude or net completed
> close-outs rather than relying on the unchanged insurance ledger.

**Research already done for you.** `public.contract_closeouts` (migration 84)
carries, per contract:

```
status              text  check (status in ('draft','completed','cancelled'))
outcome             text  check (outcome in ('keep_terminated','freeze','archive'))
deposit_held        numeric(14,3)
deductions_total    numeric(14,3)
settled_total       numeric(14,3)
written_off_total   numeric(14,3)
refund_total        numeric(14,3)
balance_due_tenant  numeric(14,3)
refund_id           uuid references public.refunds(id)
```

This is a **discriminated** record of what happened to the deposit — unlike the
generic `public.refunds` table, which has no column saying what a refund was
*for*. That distinction is why netting is defensible here and was explicitly
rejected for refunds generally (see the migration's own header comment).

**Two viable fixes. Pick one and say which in the PR:**

1. **Net it** — subtract the disposals recorded on the completed close-out:
   `deposit_held - deductions_total - refund_total - settled_total`, floored at
   zero. More accurate, and the columns exist precisely to answer this.
2. **Exclude it** — drop any contract with a `status = 'completed'` close-out
   from the sum. Simpler and fails toward understating. Understating money the
   office holds is the safer error for a tenant-facing figure, but it will read
   as zero for a partly-retained deposit, which is also wrong.

Option 1 is the better answer given the columns are there. Verify the exact
semantics in `db/migrations/114_closeout_multi_unit.sql:441-480` before writing
the arithmetic — do not trust this summary for the sign of each term.

### Where to edit

`db/migrations/216_portal_reads_its_own_insurance.sql` — **edit in place.** It
has never been applied to any database, so there is no overload trap and no need
for a 217. Its current signature is:

```sql
public.portal_insurance_total(p_tenant_id uuid, p_contract_id uuid default null)
returns numeric
```

It already, correctly:
- sums by **contract ownership** (`c.tenant_id = p_tenant_id`), not
  `insurance_payments.tenant_id`, because migration 190 does not propagate
  insurance rows on contract reassignment;
- scopes to `p_contract_id` when given;
- excludes `c.state = 'draft'`;
- excludes `hide_from_portal` contracts;
- re-states the caller guard from `portal_hidden_payment_ids` and raises
  SQLSTATE 42501 for someone else's tenant id;
- returns **only a scalar** — deliberately. An earlier revision used an RLS
  policy on `insurance_payments` and was rejected in review because a SELECT
  policy authorises every *column*, exposing the staff-entered `note`,
  `created_by`, and internal unit/building ids. **Do not reintroduce a policy on
  that table.**

### Tests

Extend `src/db/portalInsuranceTotal.sqltest.ts`. It currently has 9 passing
cases. Add at least: a completed `keep_terminated` close-out with deductions
shows the net; a full refund shows 0. Use the `withRollback` / `actAs` /
`captureRaiseError` harness from `src/db/testDb.ts` — note that a raised
exception poisons the surrounding transaction, so an expected refusal must go
through `captureRaiseError` (savepoint), not a bare `rejects.toThrow`.

### Deliberately NOT to change

`mirrorInsurance` in `src/components/admin/contracts/ContractFormDialog.tsx`
creates an `insurance_payments` row for a draft contract with a deposit. The
owner has decided this stays: holding deposits are often collected on draft
leases, and the Insurance tab and the budget's `insurance_collected` KPI should
keep counting them. Only the **portal** total excludes drafts.

### Then

Gates → `@codex review` → wait for green → **fresh** `pg_dump` → transfer and
checksum migration 216 → apply → `notify pgrst` → verify
`portal_insurance_total` exists → `gh pr merge 212 --merge --delete-branch`.

---

## PHASE 3 — Resolve #214's two open P1s, then merge

Branch `fix/whatsapp-hint-reflects-provider-state`, head `98e07e2`, in
`F:\Danat-Mostakbal`. **No migration.** Independent of #211 and #212; the owner
agreed it merges on its own once green.

### Background you need before touching this

The PR began as "the WhatsApp warning in the send-invoice dialog is stale". It
was, and provably so: production sent 88 WhatsApp notifications in 30 days, 72
delivered, 0 failed. Three review rounds then found **five** separate ways a
dialog-side *prediction* of deliverability diverges from what the sender
actually does — template channel policy, the admin-only `provider_configs`
table, `*_REQUIRED` placeholder identifiers, providers needing no mapping, and
finally `provider_param_keys`, which cannot be validated without the invoice
payload the send itself builds.

The prediction was therefore **deleted**, and the design changed to reporting
what the send actually did. `WHATSAPP_PROVIDERS` in
`src/lib/whatsappAvailability.ts` was kept and is shared with
`dispatchNotification`'s own selector — that de-duplication stands on its own.

**Do not reintroduce a predictive hint.** If the owner asks for one later, the
only safe form is certain-negative only ("no WhatsApp provider is enabled",
"this template excludes WhatsApp") on the Settings page, not per send dialog.

### Open P1 #1 — posted 2026-09-16T13:01:14Z, on `InvoiceRowsTable.tsx:164`

> **Base the success toast on the dispatched row state.** When a provider
> rejects delivery — for example because a Meta/Twilio mapping or parameter key
> is invalid — `enqueueNotification` returns the non-null notification row after
> `dispatchNotificationRecord` has marked it `failed`; the row ID therefore
> enters `outcome.queued`, and this branch still shows "Invoice sent." Fresh
> evidence after the redesign is that the sender already returns the failed row,
> but the new outcome logic checks only array lengths and discards its `state`.

The current `sendInvoiceToTenant` returns `{ queued: string[], refused: string[] }`
where `queued` holds row ids. That is not enough: a row can exist *and* be
`failed`. Read the row's `state` and treat `failed` as not-sent. Check
`src/fns/enqueueNotification.ts` and `dispatchNotificationRecord` for what is
already available on the returned row before adding a second query — memory note
`notification-id-does-not-mean-delivered` records this exact trap from the
credentials path.

### Open P1 #2 — same round, on `sendInvoiceToTenant.ts:240`

> **Consume the send outcome in the monthly invoice table.** The new `refused`
> result is consumed only by `InvoiceRowsTable`; the other caller in
> `src/components/admin/invoices/InvoicesTable.tsx:230-232` still ignores the
> result and unconditionally toasts `invoices.sent`.

Verified: `InvoicesTable.tsx:230` calls `sendInvoiceFn(...)` and discards the
result. Apply the same honest reporting as `InvoiceRowsTable`. Consider
extracting the outcome-to-toast decision into one helper so a third call site
cannot drift — a repo-wide grep for `sendInvoiceToTenant` will confirm there are
exactly two.

### Existing dictionary keys on this branch

`invoices.sendRefused` ("Nothing was sent…") and `invoices.sentPartly` ("Sent on
some channels only…"), both locales. A third key is likely needed for
"provider rejected it" as distinct from "template refused the channel" — the
i18n parity test in `src/i18n/dictionary.test.ts` fails the build if a key exists
in only one locale.

### Then

Gates → `@codex review` → wait for green → `gh pr merge 214 --merge --delete-branch`.

---

## 4. House rules that the reviewer will enforce

- **Every function gets a doc comment above it whose first line is an Arabic
  description of what it does.** English follows for the *why* — the reasoning,
  trade-off or incident behind a non-obvious choice. This applies to SQL
  functions (both a leading `--` block and `comment on function`), TypeScript,
  and test helpers. Comments explain *why*, never restate *what*.
- Files stay under 500–600 lines.
- `database.types.ts` is **hand-maintained** despite looking generated. Add new
  RPC entries by hand. Never run `gen:types` over it.
- Gates before presenting anything: `bun run typecheck`, `bun run test`,
  `bun run lint`, `npx prettier --check` on touched files. `test:sql` whenever a
  migration changes.
- Do not `git push --force`, rebase, amend or squash anything already on `main`
  — the repo is Lovable-connected.
- Commit trailer:
  ```
  Co-Authored-By: <your model> <noreply@anthropic.com>
  ```

---

## 5. Suggested order

1. Phase 1 end to end. It is green and unblocked; get it live first.
2. Phase 3 (#214). No migration, so the loop is fast.
3. Phase 2 (#212). Needs the most design thought, and a second `pg_dump`.

Each phase is independent. Do not batch the merges — one migration, one merge,
one verification at a time, because Dokploy deploys on every push to `main`.
