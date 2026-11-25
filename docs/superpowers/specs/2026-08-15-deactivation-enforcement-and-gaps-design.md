# Deactivation enforcement, gallery toggle, empty states, bilingual reports

**Date:** 2026-08-15
**Branch:** `feat/deactivation-enforcement-and-gaps`
**Status:** design approved, pending implementation

Four independent pieces of work. Section 1 is the critical one and restructures how
authentication is enforced; sections 2–4 are bounded fixes that ride along and can be
landed separately if section 1 stalls.

---

## 1. Deactivated users can still log in

### What is actually broken

`profiles.is_active` is **written by four paths and read by none.**

| Writer | Location |
| ------ | -------- |
| Admin Users table toggle | `src/hooks/useUsers.ts:230` (`useSetUserActive`) |
| User creation | `src/fns/createAppUser.ts:91` (sets `true`) |
| Closeout restore RPCs | `db/migrations/87_contract_closeout_rpcs.sql:1063`, `114_closeout_multi_unit.sql:828` |
| Contract trigger | `db/migrations/21_settings_integrations.sql:51-77` |

No login path, no route guard, and no RLS helper (`has_role`, `is_staff`,
`has_permission`) consults it. The switch in the Users table has always been decorative.
This is the codebase's recurring written-but-never-read defect shape.

### Requirement 1.1 is already satisfied — the flags are not conflated

The task asks to differentiate the tenant-form portal toggle from user deactivation.
Two distinct columns already exist and already carry those two meanings:

| Flag | Table | Meaning | Enforced today? |
| ---- | ----- | ------- | --------------- |
| `tenant_portal_enabled` | `tenants` (migration 04:122) | Portal access off, account intact | **Yes** — `portal.tsx:171`, `createPayment.ts:183`, RLS in migration 06:106 |
| `is_active` | `profiles` (migration 01:66) | Account deactivated | **No** — this is the gap |

No new column is needed. An earlier draft of this design proposed adding
`profiles.portal_enabled`; that was based on a misreading and is withdrawn.

### The one genuine contamination

Migration 21's trigger writes the **account** flag for a **portal** reason. Its own
comment says "deactivate that tenant's portal login", but its body is:

```sql
update public.profiles set is_active = false
 where tenant_id = _tenant and is_active;
```

Today this is inert because nothing reads `is_active`. The moment enforcement ships, that
trigger silently converts "contract ended" into "account locked out". **Migration 142
repoints it at `tenants.tenant_portal_enabled`**, where it always belonged. The two
closeout-restore RPCs that set `is_active = true` purely to undo this trigger
(`87:1058-1061`, `114:818-821`) have that step **deleted**, not rewritten — the step above
it already restores `tenant_portal_enabled` (`87:1053-1056`, `114:812-815`), so once the
trigger writes the portal flag there is nothing left to undo. Leaving it in would let any
contract restore silently re-activate a deliberately deactivated account.

### Production state (verified 2026-08-15)

Eight profiles total:

| `is_active` | tenant? | count |
| ----------- | ------- | ----- |
| false | yes | **1** |
| true | no (staff) | 3 |
| true | yes | 4 |

The single inactive row — username `150`, tenant عبد الرحيم — has
`tenant_portal_enabled = true` and **one active contract**. The migration-21 trigger only
fires when a tenant has *no* active contract, so it cannot have written that row: it was
an admin acting through the Users-table switch. That row *is* the reported bug, and it is
the acceptance-test account.

### Backfill: express the intent, not the assumption

A blanket "restore every `false` row" would un-deactivate exactly the account the feature
exists to block. The backfill is instead scoped to rows the trigger could plausibly have
authored:

```sql
update public.profiles p set is_active = true
 where not p.is_active
   and p.tenant_id is not null
   and not exists (
     select 1 from public.contracts c
      where c.tenant_id = p.tenant_id and c.state = 'active');
```

On production this matches **zero rows** — no lockouts created, the deliberate
deactivation survives — while still doing the right thing on any database where the
trigger has fired. Staff profiles are excluded by `tenant_id is not null`, because the
trigger never touches them, so a `false` there is always admin-authored.

### Enforcement in three layers

A login-form check alone is theatre: `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are baked into the browser bundle, so anyone can call
GoTrue's `/token?grant_type=password` directly.

**Layer A — reject at the login server function (the UX requirement).**
`src/fns/signInWithIdentifier.ts:86-90` currently selects only `email` in
`findAccountEmail`. Widen it to `email, is_active` and return
`{ ok: false, error: "ACCOUNT_DEACTIVATED" }`.

**The flag is checked *after* the GoTrue call, not before it.** Rejecting an
inactive account ahead of the password check would let anyone with a username
and no credentials learn that the account exists and is disabled. Verifying
first means only someone who could already have signed in learns anything.

A separate branch maps GoTrue's own `user_banned` error, which arrives *before*
the password is checked once `banned_until` is set. That branch does disclose
existence — but the disclosure is GoTrue's and is reachable by calling
`/token` directly, so mirroring it costs nothing an attacker cannot already
obtain, and the alternative is telling a real deactivated tenant their password
is wrong. The two branches therefore protect disjoint states: the
post-password check covers inactive-but-not-yet-banned rows only.

Both login pages (`src/routes/auth.tsx`, `src/routes/portal_.auth.tsx`) render:

- ar — `تم إيقاف الحساب. يرجى التواصل مع الإدارة.`
- en — `Account is deactivated. Please contact the administrator.`

The return-flag shape is deliberate: a thrown `Response` in a server function *resolves*
client-side via `x-tss-raw`, so rejection must be an explicit flag the caller asserts on,
never a thrown `Response`.

**Layer B — close the fallthrough that makes Layer A cosmetic.**
`src/auth/AuthProvider.tsx:62-83` returns only when `result.ok` is true. An `ok: false`
return does **not** short-circuit — control falls through to a direct client-side
`signInWithPassword` using the legacy `<username>@users.local` mapping from
`src/auth/loginIdentity.ts:59-64`. Ship Layer A without this fix and every legacy account
logs in through the back door. This is the single most important line in the change.

**Layer C — make an issued token inert.** Two closures, both required:

1. **Ban at the issuer.** Move the deactivation write out of the browser
   (`useUsers.ts:230`) into a new server function `setUserActive` running under the
   service role, which updates `profiles.is_active` *and* sets
   `auth.users.banned_until` (`'infinity'` on deactivate, `null` on reactivate) via the
   GoTrue Admin API. GoTrue then refuses to issue tokens, and existing refresh tokens
   fail on next refresh — which is what satisfies requirement 3 (session invalidation).

   **Migration 142 must also ban every already-inactive profile**, after the
   trigger-authored restore. The server function only bans accounts toggled from then on;
   without a backfill, every row deactivated before this change keeps a working password
   grant against GoTrue. That includes the production account that reported the bug —
   verified as `is_active = false` with `banned_until` unset.

   The audit write comes along, but not the helper: `logAuditForCurrentSession` reads the
   browser session and throws without one (`src/lib/audit.ts:18-20`). Server-side it
   becomes `supabaseAdmin.rpc("write_audit", …)`, as in `createAppUser.ts:120`.

   The two writes are not one transaction — the profile is in Postgres, the ban is in
   GoTrue — so on deactivate the ban goes first and the profile write second, lifting the
   ban again if the profile write fails. The failure direction must always be "still
   locked out", never "quietly open".
2. **Gate in RLS — for staff.** `has_permission` (highest definition: migration
   16:117-145), `is_staff` (migration 01:114-126) and **`has_role` (migration 01:101-112)**
   additionally require the caller's `profiles.is_active`. This closes the
   direct-PostgREST path for every staff role independently of the login change.

   `has_role` is the important one and an earlier draft of this design wrongly excluded it,
   reasoning from its poor coverage of *tenant* predicates (1 of 32). That measured the
   wrong thing: `has_role` gates the **admin** policies, including all three on `profiles`
   itself (`01:141`, `:148`, `:153-154`), `companies_write_admin`, and
   `branding_admin_write` on `storage.objects` (`21:41-45`). Excluding it would have left
   the highest-privilege role the least defended — a deactivated admin keeping read and
   write over every profile row.

   **This does not cover tenants, and the gap is deliberate.** Portal policies derive
   access straight from the profile row — `select 1 from public.profiles p join
   public.tenants t … where p.id = auth.uid() and t.tenant_portal_enabled`
   (migration 06:100-107) — and never consult `is_active`. There are **32** such
   predicates across ~15 migrations, with no `current_tenant_id()` helper to patch in one
   place; only **1** of them routes through `has_role`, which itself has 74 call sites.
   Re-issuing 32 policies is disproportionate to this change and is its own regression
   risk.

   The tenant closure is the ban instead: GoTrue refuses new tokens and every refresh
   fails. Production runs `GOTRUE_JWT_EXP=3600`, so a tenant's already-issued access token
   stays usable for **at most one hour** after deactivation, after which the session is
   gone for good. That residual hour is the accepted cost, and it is the reason the
   migration-time ban backfill above is not optional: an unbanned inactive row has no
   such bound at all.

   Migration 21's trigger is also repointed here, and the two closeout-restore RPCs lose
   the step that undid it. `87_contract_closeout_rpcs.sql:1058-1061` and
   `114_closeout_multi_unit.sql:818-821` each end with an unconditional
   `update public.profiles set is_active = true`, added solely to reverse the one-way
   trigger. Once the trigger writes `tenant_portal_enabled` — which the step above it
   already restores — that write becomes a way for any contract restore to silently
   re-activate an account an admin deliberately deactivated, and to desync it from
   `banned_until`.

### Explicitly out of scope

A GoTrue custom-access-token or password-verification hook would enforce at the issuer
declaratively, but GoTrue's configuration lives in the separately-deployed Supabase
compose stack, not this repository. Recreating that compose has previously rotated keys
and wiped the database. Not on this change's critical path.

### Tests

- `src/fns/signInWithIdentifier.test.ts` — active user resolves and signs in; inactive
  user returns `ACCOUNT_DEACTIVATED` and never calls GoTrue; deactivating between
  attempts flips the outcome. The `createServerFn` mock skips `.validator()`, so the Zod
  schema is exported and asserted directly rather than through the handler.
- `src/auth/AuthProvider.test.tsx` — an `ok: false` result does **not** reach the
  fallback `signInWithPassword`. This is the regression that would silently void the
  feature.
- `src/db/deactivationEnforcement.sqltest.ts` — the repointed trigger writes
  `tenant_portal_enabled` and leaves `is_active` alone; the backfill predicate matches a
  trigger-authored row and skips an admin-authored one; `has_permission` returns false
  for an inactive profile.

---

## 2. Gallery "in gallery" toggle cannot be switched off

`src/components/admin/landing-page/GalleryTable.tsx:68`:

```ts
const shown = !!media.show_in_gallery && media.is_active !== false;
```

For a row that is inactive but flagged, `shown` is `false`, so the menu item sends
`onToggleGalleryItem(media.id, !shown)` — that is, `true`. It keeps trying to turn the
flag **on** and can never turn it off.

The parent handler (`admin.settings.landing-page.tsx:588`) already writes
`show_in_gallery` alone, so the fix is confined to the derivation:

```ts
const shown = !!media.show_in_gallery;
```

The `is_active` signal is not discarded — it becomes secondary text on the card
(`مخفي — العنصر غير مُفعّل` / `Hidden — item inactive`) so a flagged-but-invisible row
still reads as such without the flag becoming unreachable. Add the optimistic update and
rollback the task asks for to `updateMedia`.

---

## 3. Shop and slide grids render blank when empty

`ShopsTable.tsx:46` and `SlidesTable.tsx:33` render `x?.map(...)` with no empty branch.
No `EmptyState` component exists in `src/components/ui/`.

Add `src/components/ui/empty-state.tsx` — icon, title, subtitle, optional action slot,
styled against the existing Card/muted-foreground vocabulary. Use it in both grids, and
migrate `GalleryTable`'s ad-hoc `<p>` (lines 27–35) onto it so the three read alike.

**The loading trap:** both components take `T[] | undefined`, where `undefined` means
*loading* and `[]` means *empty*. Gating on falsy-or-empty would flash "No shops found"
on every page load. Gate on `Array.isArray(x) && x.length === 0`.

Copy: `لا توجد محلات بعد` / `No shops yet`, `لا توجد شرائح بعد` / `No slides yet`, each
with a helper subtitle pointing at the existing Add button.

---

## 4. Scheduled and emailed reports are Arabic-only

Migration 140 split `tenants.commercial_name` into `commercial_name_ar` /
`commercial_name_en`, and `src/lib/partyName.ts` resolves them per locale for print,
download and email. The SQL report builder never got the change.

**The live definition is migration 106, not 44.** Four migrations define
`build_scheduled_report_html` (07, 31, 44, 106); `create or replace` means the
highest-numbered body wins. Both tenant-name sites are in 106:

- `106:366` — payment rows
- `106:390` — overdue rows

both `coalesce(t.name, '—')`, with no commercial name and no locale awareness. It is
emailed by `src/fns/runReportSchedule.ts:48`. That is the only path — "scheduled" and
"emailed" reports are the same function.

Migration **143** re-issues the function with a helper mirroring `resolvePartyName`
(142 is the enforcement migration above; the report rewrite is kept separate because its
failure mode is transcription, not logic, and it should be revertable on its own):

```sql
create or replace function public.tenant_display_name(t public.tenants, p_is_ar boolean)
returns text language sql immutable as $$
  select case when p_is_ar
    then coalesce(nullif(btrim(t.commercial_name_ar), ''),
                  nullif(btrim(t.commercial_name_en), ''),
                  nullif(btrim(t.commercial_name),    ''),
                  nullif(btrim(t.name),               ''),
                  nullif(btrim(t.name_en),            ''))
    else coalesce(nullif(btrim(t.commercial_name_en), ''),
                  nullif(btrim(t.commercial_name_ar), ''),
                  nullif(btrim(t.commercial_name),    ''),
                  nullif(btrim(t.name_en),            ''),
                  nullif(btrim(t.name),               ''))
  end;
$$;
```

A commercial party stays a commercial party: an English report falls back to the Arabic
trade name before it falls back to the tenant's personal name, because printing a
different legal entity is worse than printing the wrong script.

**Two mechanical constraints.**

1. `v_is_ar` is assigned at `106:411`, *after* both row queries at `:366` and `:390`, so
   the assignment moves. It is a **one-line move, not a restructure**: `v_schedule` is
   already populated at `106:308`, 58 lines before the first row query, and nothing
   between 308 and 411 reassigns it. The assignment goes immediately after `:308`.
2. `create or replace function` cannot patch a body, so migration 143 re-issues all
   ~560 lines of the function to change two expressions. **The failure mode here is
   transcription, not logic.**

Because of (2), the test asserts on rendered HTML rather than on the function existing:
`src/db/bilingualReportNames.sqltest.ts` builds a tenant with both trade names and asserts
`build_scheduled_report_html` output contains the Arabic name for an `ar` schedule and the
English name for an `en` schedule, plus a fallback case with `commercial_name_en` null.

---

## Gates

`bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:sql`, plus
`clean-code-guard` on production code and `test-guard` on tests.

## Deployment sequencing

Merging to `main` auto-deploys via Dokploy. Migration 142 must be applied to the live
Supabase database **before** the container swaps, followed by
`notify pgrst, 'reload schema'`, or the new bundle runs against the old schema. `pg_dump`
first — schema changes are not reversible.
