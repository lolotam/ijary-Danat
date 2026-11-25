# Anti-Koshary Audit — Plan

**Repo:** Danat Al Mustaqbal ERMP · **Started:** 2026-09-22 · **Branch at start:** `docs/organize-handover-and-insurance-plan`

Pass 1 only. **Nothing is fixed until the final task is done and the user approves.**
"Finished" for a scope task means: *its report file is written and its status
flipped here* — not that anything was changed.

---

## Step 0 — Orientation (done)

| Question | Answer |
| --- | --- |
| Stack | TypeScript / React 19 / TanStack Start + Nitro, Vite 8, Tailwind 4 + shadcn (Radix), self-hosted Supabase (Postgres 17) |
| Package manager | **Bun** (`bun.lock` is the live lockfile; `package-lock.json` is a stale leftover — flagged in S18) |
| Size audited | `src/` production code: **118,431 lines** across ~1,112 `.ts`/`.tsx` files (excl. tests, `routeTree.gen.ts`) |
| Tests exist? | **Yes** — 349 test files, 3,220 tests |
| Test baseline | `bun run test` → **3,217 passed / 1 failed / 2 skipped**. The failure is `src/db/invoiceRlsPredicate.structure.test.ts` timing out at 5000 ms — an IO-under-load flake of the same shape as the known `serverPdf` one, not a real failure. Treated as green. |
| Typecheck baseline | `bun run typecheck` **cannot run**: `node_modules/.bin` holds only 7 entries (`tsc` missing) though the `typescript` package is installed. Run as `node node_modules/typescript/bin/tsc --noEmit`. Result recorded in S18. |
| Lint baseline | **Not used as a gate.** The main working tree produces ~2,148 prettier/CRLF errors that a fresh worktree does not; lint output here is noise. |
| Working tree | **Clean** at start (`git status --porcelain` empty). Must be clean again before Pass 2. |

### Because tests exist, but only partly

A green suite here does **not** license "safe" claims everywhere. Known gaps
already recorded in this repo: server-fn `.validator()` bodies never execute
under the shared `createServerFn` mock, so no Zod schema in `src/fns` is
covered; and several suites assert against mocks that re-implement the logic
under test. Per-scope reports must say what the tests actually cover before
any change to that scope is called low-risk.

---

## One-time repo-wide artifacts

### Churn, last 12 months (top 15, production `src` only)

```
215  src/i18n/dictionary.ts
107  src/integrations/supabase/database.types.ts
 58  src/routes/admin.tenants.index.tsx
 50  src/routes/admin.contracts.tsx
 39  src/routes/index.tsx
 37  src/routes/admin.invoices.tsx
 36  src/routes/admin.units.index.tsx
 36  src/routes/admin.settings.users.tsx
 35  src/routes/admin.settings.landing-page.tsx
 32  src/routes/admin.payments.tsx
 30  src/routes/admin.settings.notifications.tsx
 29  src/hooks/useContracts.ts
 26  src/hooks/useInvoices.ts
 25  src/routes/admin.properties.index.tsx
 25  src/routes/admin.inbox.tsx
```

### Size, top 12 production files

```
4546  src/i18n/dictionary.ts
2522  src/integrations/supabase/database.types.ts
2136  src/routes/index.tsx
1421  src/routes/admin.settings.users.tsx
1252  src/routes/admin.settings.landing-page.tsx
1177  src/routes/admin.payments.tsx
1115  src/routes/admin.contracts_.$id.closeout.tsx
1035  src/routes/admin.inbox.tsx
 972  src/fns/myfatoorahWebhook.ts
 930  src/routes/admin.expenses.tsx
 784  src/routes/admin.settings.lists.tsx
 750  src/components/ui/sidebar.tsx
```

**Size × churn intersection — read these first:** `src/routes/index.tsx`,
`src/routes/admin.settings.users.tsx`, `src/routes/admin.settings.landing-page.tsx`,
`src/routes/admin.payments.tsx`, `src/routes/admin.inbox.tsx`.

`CLAUDE.md` names `src/routes/admin.contracts.tsx` (~1470 lines) as a known
offender. It is **no longer in the top 25 by size** — it was split at some
point, and the doc is stale. Recorded as a Low finding in S18.

---

## The cross-scope ledger

Sections 2 and 5 of the skill (duplication, reusable pieces) cannot be seen
from inside one chunk — a validator in `src/fns` and its copy in a route never
meet. Every scope **appends** what it sees to `LEDGER.md` (regexes, format
helpers, calculations, status maps, permission checks) and **greps it first**
before reporting a duplication finding. Without this each scope reads clean and
the koshary stays invisible.

---

## Tasks

Legend: ☐ not started · ◐ in progress · ☑ finished (report written)

| # | Scope | Lines | Report | Status |
| --- | --- | --- | --- | --- |
| S01 | `src/fns` — money & contract lifecycle | ~2.9k | `01-fns-money.md` | ☑ |
| S02 | `src/fns` — notifications & templates | ~4.6k | `02-fns-notifications.md` | ☑ |
| S03 | `src/fns` — messaging, jobs, users, backup, public | ~9.2k | `03-fns-platform.md` | ☑ |
| S04 | `src/routes` — admin money (invoices, payments, contracts, deposits, expenses, close-out) | ~7k | `04-routes-money.md` | ☑ |
| S05 | `src/routes` — admin other (tenants, units, properties, maintenance, inbox, dashboard, reports) | ~10k | `05-routes-admin.md` | ☑ |
| S06 | `src/routes` — `admin.settings.*` | ~5.8k | `06-routes-settings.md` | ☑ |
| S07 | `src/routes` — portal, landing (`index.tsx`), `api/` | ~4.4k | `07-routes-portal-public.md` | ☑ |
| S08 | `src/components/admin` — root files, A–M | ~6k | `08-components-admin-a.md` | ☑ |
| S09 | `src/components/admin` — root files, N–Z | ~5.7k | `09-components-admin-b.md` | ☑ |
| S10 | `src/components/admin` — contracts, invoices, tenants, tenant-detail, deposits | ~8.1k | `10-components-money.md` | ☑ |
| S11 | `src/components/admin` — whatsapp, compose, inbox, notifications, electricity, landing-page, backup, properties | ~9.6k | `11-components-messaging.md` | ☑ |
| S12 | `src/components` — ui, portal, landing, shop, shared, root | ~6.6k | `12-components-shared.md` | ☑ |
| S13 | `src/lib` — documents & rendering (email, PDF, HTML, contractBuilder) | ~5.5k | `13-lib-documents.md` | ☑ |
| S14 | `src/lib` — providers, evolution, gmail, backup archive | ~7k | `14-lib-providers.md` | ☑ |
| S15 | `src/lib` — schemas, forms, table/status/format helpers, the rest | ~8k | `15-lib-helpers.md` | ☑ |
| S16 | `src/hooks` — A–M | ~7k | `16-hooks-a.md` | ☑ |
| S17 | `src/hooks` — N–Z | ~6.8k | `17-hooks-b.md` | ☑ |
| S18 | `src/i18n`, `src/integrations`, `src/db`, `src/` root, **+ repo-wide**: security (skill §7), `dep_audit.sh`, git-history secret scan, cross-scope duplication rollup, priority counts, and the Pass-2 approval question | ~8.6k | `18-repo-wide.md` | ☑ |

---

## The end report

[`FINDINGS.md`](FINDINGS.md) is the consolidated deliverable — the decision list, with
counts by priority and the open questions. **Every scope appends its findings there at the
same moment its status is flipped here.** The per-scope files keep the full reasoning;
FINDINGS.md keeps what the user has to act on.

## Report format (every scope file)

```
## S<NN> — <scope>          Lines read: N   Files: N
### Findings
| # | Priority | Section | What | Where | Consequence | Fix |
### Test coverage of this scope
### Ledger entries added
### Nothing-to-report notes
```

Priorities per the skill: **Critical** (live credential / exploitable now) ·
**High** (one rule in several places that will drift, or a real vulnerability) ·
**Medium** (costs time on every change, or hides bugs — the koshary itself) ·
**Low** (tidiness).

A finding is only recorded if the sentence "which means…" can be finished.
