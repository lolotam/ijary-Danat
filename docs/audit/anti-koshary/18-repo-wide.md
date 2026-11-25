# S18 — `src/i18n`, `src/integrations`, `src/db`, `src/` root — plus the repo-wide security & dependency pass

**Lines read:** ~8,100 (scope files) + repo-wide scans · **Date:** 2026-09-22

`i18n/dictionary.ts` (4546) · `integrations/supabase/database.types.ts` (2522) ·
`db/testDb.ts` (281) · `db/*Fixtures.ts` (480) · `i18n/provider.tsx` (78) ·
`integrations/supabase/{client,client.server,auth-middleware,auth-attacher}.ts` ·
`src/{router,server,start,client,instrument.*}.ts(x)`.

---

## Part A — scope findings

### A1 · Low — `CLAUDE.md`'s "known offenders" list names the two files that were already fixed

**Where:** `CLAUDE.md:45-46`

> *"Known offenders to split when next touched: `src/routes/admin.contracts.tsx` (~1470 lines),
> `src/routes/admin.invoices.tsx`."*

Actual sizes today: **457** and **524**. Both were split; the note was not updated. Meanwhile
the eight components that genuinely breach the ceiling (S04 #2, S05 #4, S06 #2, S07 #1) are
not named anywhere.

**Which means:** the one place a new contributor looks for "which files are dangerous"
points at two that are now fine and stays silent about `routes/index.tsx` (1,922-line
component), `admin.settings.landing-page.tsx` (1,052) and `admin.settings.users.tsx` (1,421).

**Fix:** replace the two names with the current list when Pass 2 lands, and note that the
list is generated from `wc -l`, not memory.

### A2 · Low — `dictionary.ts` and `database.types.ts` are the two highest-churn files in the repo, by design

`dictionary.ts` changed **215** times in 12 months and `database.types.ts` **107** — double
the next file. Both are hand-maintained data (`CLAUDE.md` documents why
`database.types.ts` must not be overwritten by `gen:types`). **Not a finding**: high churn
on a catalogue is normal, the parity test guards the dictionary, and splitting either would
break the tooling that depends on their shape. Recorded so the churn table is not
misread.

**One consequence worth noting:** `dictionary.ts` at 4,546 lines is the file S06 #1 asks to
grow by 306 entries. It will pass 5,000 lines. If it is ever split, split by locale
(`ar.ts` / `en.ts`) — the parity test compares the two objects and will keep working.

---

## Part B — Security (skill §7)

**Result: no Critical, no High. Nothing to rotate.** Every check below was run; this is what
each returned.

| Check | Result |
| --- | --- |
| Provider key shapes (`sk-`, `AKIA`, `ghp_`, `xox*`, `AIza`, PEM blocks) | **0 hits** |
| Connection strings with inline credentials | 5 hits, **all false positives**: `<password>` placeholder in `db/README.md`, and `postgres:postgres` against the ephemeral local test container (`scripts/gen-types.sh`, `scripts/test-db.sh`, `src/db/testDb.ts`) |
| Committed `.env` files | **none** — `.env` and `.env.production` are ignored; only `.env.example` is tracked, with truncated placeholders |
| Credential-shaped assignments | all hits are i18n labels containing the word "password", or `docker exec printenv` reading a key at runtime in `scripts/verify-myfatoorah-live.sh` |
| **Git history** (`-S'SUPABASE_SERVICE_ROLE_KEY='`) | one commit (`0f49e17`) — it adds `.env.example` with `eyJhbGciOi...`, a truncated placeholder. **No secret has ever been committed.** |
| `eval` / `new Function` / deserialization | **0 hits** |
| CORS wildcards / `origin: true` with credentials | **0 hits** |
| SQL built by concatenation | none — every query goes through PostgREST builders or parameterised RPCs |
| `localStorage` / `sessionStorage` | 6 writes: theme, locale, an invoices layout preference, a shops view preference, a reminder-seen flag, a reload marker. **No auth tokens, no PII.** |
| Sensitive data in logs | none — the lines matching `credential`/`token` log an `error.message` or a message string, never a value |
| XSS sinks | 2 × `dangerouslySetInnerHTML`: `ui/chart.tsx` (shadcn CSS variables) and `compose/SignatureManager.tsx:340`, whose input is `sanitizeSignatureHtml(...)` — DOMPurify with a tag/attribute allowlist, applied **on write** (`useEmailSignatures.ts`) **and on render**, with the SSR branch returning `""` rather than the input. Correct. |

### B1 · Authorization coverage is complete

Enumerated **every** `createServerFn` in `src/fns` and named its gate. Result: all but six
carry `requireSupabaseAuth` **plus** a `has_permission` / `has_role` / staff check. The six
with no gate are the six intended public endpoints — `publicBranding`,
`publicRuntimeConfig`, `resolveMapEmbed`, `signInWithIdentifier`, `submitContactInquiry`,
`submitLeasingInquiry` — each reviewed individually in S03 and each correct for its purpose.

**There is no unprotected mutation in this codebase.** The authorization findings in this
audit (**H2** wrong failure reporting, **H5** UI/server model split, **H6** bypassable rate
limit) are all about *how* a decision is enforced or reported — not about a missing check.

### B2 · Out of the agreed boundary, flagged not audited

The scope agreed at Step 0 was `src/`. Two database-level concerns are recorded by the
project's own notes and were **not** verified here because `db/migrations` was out of
boundary: multi-company isolation is not enforced in RLS (`company_id` exists on 32 tables;
staff policies do not use it), and `revoke … from public` does not remove `anon` /
`authenticated` grants, which a number of `SECURITY DEFINER` functions may still carry.
**Neither is a finding of this audit.** If a second company is ever onboarded — see **H7** —
both need a dedicated SQL-scoped review first.

---

## Part C — Dependencies

The bundled `dep_audit.sh` did not complete within the time budget on this machine; `npm
audit` and `npm outdated` were run directly instead, and are reported separately for runtime
and build-chain as the skill requires.

### C1 · High (runtime) — `nodemailer` 9.0.3, four advisories

**Ships to production.** Used by `src/lib/providers/smtp.ts` and reachable whenever the
`smtp` provider is enabled (`dispatchNotification.ts:96` falls back to it when `resend` is
absent).

| Advisory | Impact |
| --- | --- |
| GHSA-wmmp-3585-3rmp | IDN/Punycode allow-list bypass → **delivery to an attacker-controlled domain** |
| GHSA-cc9r-2j5m-2m83 | RFC 5322 comment mis-parsing → same |
| GHSA-8m3c-c648-2xjj | `resolveContent()` bypasses `disableFileAccess` / `disableUrlAccess` |
| GHSA-2x7j-588g-ccc2 | O(n²) addressparser → remote DoS |

**Exposure here is narrow but real.** Recipient addresses come from `tenants.email` and
admin profiles — both admin-entered — so the two domain-bypass advisories need someone who
can already set a tenant's email address. That is a lower bar than it sounds: a tenant
record is edited by any operator with `tenants.update`.

**Fix:** the advisory range is `<= 9.1.0` and `package.json` declares `^9.0.3`, so the fixed
version is **inside the existing range** — `bun update nodemailer` resolves it with no
major bump. Do this first and re-run the audit to confirm. **Also worth deciding:** if the
Resend migration made SMTP permanently unused, removing the dependency is better than
patching it.

### C2 · Moderate (build/test only) — `@vitest/mocker`

`GHSA-82fw-gwwq-j7x9`, path traversal / arbitrary file read via a redirect mock. Affects
`2.1.0 – 4.1.10`; the repo runs `vitest ^4.1.10`. **Does not ship** — it runs in the test
process only, on this repo's own test files. Real, but not on a deadline.

**Fix:** bump `vitest` past 4.1.10 (a patch within the declared range).

### C3 · Low — many minor versions behind, and two large gaps

~28 `@radix-ui/*` packages are 4–10 minors behind (all *minor*, all inside the declared
`^` ranges). Two larger gaps worth a decision rather than a bump:

- `@eslint/js` 9.39.4 → **10.0.1** (major)
- `@lovable.dev/vite-tanstack-config` 2.7.6 → **2.23.1** (16 minors — this is the build
  config package; a jump this size deserves its own PR)

Being behind is **not** a security finding. Listed so the user can choose.

### C4 · Medium — `--frozen-lockfile || bun install` makes the lockfile advisory

**Where:** `Dockerfile:5`

```dockerfile
RUN bun install --frozen-lockfile || bun install
```

`--frozen-lockfile` exists to fail the build when `package.json` and `bun.lock` disagree.
The `|| bun install` fallback converts that deliberate failure into a **silent fresh
resolution**, so a production image can be built from dependency versions that were never
tested.

**Which means:** the one guard against a dependency drifting between local and deploy is
disabled. This repo has already been bitten by the adjacent failure — a delegated agent
removed a declared dependency from `package.json` while code still imported it, and the
expectation at the time was that *"the deploy build would fail."* With this fallback, it
would not have; it would have resolved something and shipped.

**Fix:** drop `|| bun install`. If the frozen install genuinely fails, that is the signal,
and the fix is to commit the updated lockfile.

**Note for Pass 2:** `package-lock.json` is present locally but **gitignored on purpose**
(`.gitignore:85-86`: *"npm writes this on every `npm install`; bun.lock is the lockfile
Docker uses."*). It is not a stray artifact — an earlier note in `FINDINGS.md` called it a
"stale leftover" and that was wrong. Bun is the package manager; `bun.lock` is the lockfile.

---

## Part D — cross-scope consolidation

Every finding that spans more than one scope, with its full repo-wide count. These are the
numbers Pass 2 should plan against — the per-scope reports each saw only their slice.

| Pattern | Repo-wide count | Findings |
| --- | --- | --- |
| `throw new Response(...)` in a server fn — resolves client-side as success | **33 files** | H1, H2 |
| `rpc("has_permission")` preamble, 3 incompatible variants | **48 files**, 9 record the denial | M3 |
| `locale === "ar" ? … : …` bypassing the dictionary | **306 sites**, 94 of them in the landing-page feature | H9 |
| Unbounded / capped reads that silently truncate | dashboard + 4 in `attachTenantLocations` + **8 CSV exports** | H10, H11 |
| `escapeHtml` implementations | **6**, three weaker | H12 |
| Arabic font stacks | **6 different values** across 5 renderers | M17 |
| Components over 500 lines | **13** (3 in routes/money, 5 in routes/admin, 2 in settings, 1 landing page, 2 in components) | M13, M19 |
| "Which company are we" | **23 reads**, 8 of them a non-deterministic unordered `LIMIT 1` | H7 |
| Outbound HTTP without a timeout | **6 of 10** callers | H13 |
| Portal cache invalidation | **4 mechanisms**, minority coverage | M22 |
| `catch { toast.error(…) }` discarding the error | **10 sites** | M16 |

## Test coverage of this scope

`dictionary.test.ts` is the strongest guard in the repo (S06). `database.types.ts` has no
test and cannot easily have one — it is hand-maintained by the process `CLAUDE.md` describes.
`src/db/*Fixtures.ts` support the SQL suite (`bun run test:sql`, needs Docker; note the
known Hyper-V port reservation — use `TEST_DB_PORT=55329`).

**Consequence for Pass 2:** C1 and C2 are dependency bumps verified by `npm audit` plus the
full suite. C4 is a one-word Dockerfile change whose verification is *the next deploy build
succeeding*. A1 is documentation.

## Ledger entries added

See `LEDGER.md` — the security scan results (all clean), the dependency findings, the
lockfile facts, and the cross-scope consolidation table.
