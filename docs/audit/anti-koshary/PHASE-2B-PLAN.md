# Phase 2B — agreed implementation plan

**Status: plan only. Nothing here has been implemented or merged.**
Debated 2026-09-23 against `main` at `9518ec0`: first reviewer Claude Opus 5.5, challenger Codex
GPT-6 Astra (medium effort, read-only), decisions by the advisor per the owner's instruction. Every
claim below was checked against code; the load-bearing ones were re-read by hand after the debate.

Repo rules apply to every PR: 500–600 line ceiling, Arabic doc comment above every function, gates
`bun run typecheck` + `bun run test` (+ `bun run test:sql` for database changes, + `bun run build`
before merge), clean-code-guard / test-guard / docs-guard. Pushing to `main` deploys; a migration is
applied by hand over SSH **before** the code that needs it.

---

## Owner decisions — answered 2026-09-23

1. **Insurance → (a) contract deposit.** The "Insurance Paid" column shows `contracts.deposit`, and a
   manual insurance entry writes its amount to `contracts.deposit` for that contract. Close-out keeps
   reading `insurance_payments` (unchanged).
2. **Contacts → yes.** Changing a tenant user's email on the user form also changes their **login
   email** (GoTrue) and writes it back to the tenant. Tenant record wins on other fields; a blank
   never clears.
3. **INV-0007725 → yes, approved.** Still in order: read-only diagnosis, state the exact delta,
   `pg_dump`, then run the repair and verify before/after figures. If the diagnosis finds something
   other than a stale `paid` figure (e.g. a missing allocation), stop and report instead of
   recomputing.

PRs 3, 6 and 7 are now unblocked.

## Owner questions as originally asked (kept for the record)

1. **Insurance (blocks Tasks 2 and 8).** The "Insurance Paid" column and the manual-insurance
   write-back must both mean the same figure. Which is it?
   - (a) **contract deposit** — `contracts.deposit`, the amount written on the contract;
   - (b) **gross collected** — everything received into `insurance_payments`;
   - (c) **net held** — collected minus close-out deductions, settlements and refunds (what the
     portal already shows, migration 216).

   Why it matters: close-out reads `insurance_payments`, not `contracts.deposit`
   (`db/migrations/87_contract_closeout_rpcs.sql:87`), and the two are allowed to differ on purpose —
   a save with a zero deposit deliberately keeps a manual holding (`useContractInsurance.ts:39`).
2. **Contacts (blocks Task 3).** When a tenant user's email is changed on the user form and written
   back to the tenant, should their **login email** change too? (Default for everything else:
   the tenant record wins; a blank field never clears the tenant's value.)
3. **INV-0007725 repair (Task 10, live data).** Not a plan item. After the read-only inspection in
   PR 7, you'll get the exact defect and the proposed delta, and a separate yes/no.

---

## Crossed off — already done or not wanted

| Item | Why |
| --- | --- |
| **H7** unordered company reads | All 25 `companies … limit(1)` reads are ordered. The one flagged (`recordSentResendMessage.ts:34`) has `.order("created_at")` after a comment block. |
| **H13** 15 s timeouts on providers | Resend, Postora, Twilio, WhatsApp already use `AbortSignal.timeout(PROVIDER_TIMEOUT_MS)` = **20 s** (`src/lib/providers/types.ts:15`); SMTP 20/20/60 s; Gmail token refresh bounded; Evolution has its own abort. Changing 20→15 is a policy change nobody asked for — the requirement was "no indefinite hangs". What's left is in PR 1. |
| **Task 3 prefill** | Already built: `CreateUserDialog.tsx:111` fills email and `whatsapp ?? mobile`. Only the write-back remains. |
| **Task 9 link reuse** | Already built: `createPayment.ts:340-388` reuses a pending link only when amount and method still match, and resets it otherwise. Only an expiry is missing. |
| **Task 10 "amount strictly < balance"** | Dropped. The database rejects only `amount > balance` (`191_partial_payment_resync_on_edit.sql:130`), so a partial payment may clear an invoice. "Strictly less" would forbid that; it reads as a transcription slip, not intent. |

---

## PR sequence

### PR 1 — Remaining notification timeouts (H13 residue)
- **Files:** `src/fns/gmailSend.ts:217`, `gmailSyncJob.ts:128`, `gmailAttachment.ts:109`,
  `gmailTrashMessages.ts:131` — add `signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)`.
- Errors name the provider; also handle Evolution's existing `AbortError`
  (`src/lib/evolution/client.ts:100`), not only `TimeoutError`.
- **Do not shorten any existing timeout.** Dispatch treats a throw as retryable
  (`dispatchNotification.ts:186`): aborting after the provider accepted but before it answered can
  send twice on retry, and a shorter timeout makes that likelier.
- **Tests:** a hung connection *and* a hung response body per call site.

### PR 2 — Low-risk list behaviour (Tasks 1, 4, 5/6, 7)
- **Task 1:** pass `archiveMode: "all"` to the **summary only** (`admin.contracts.tsx:121-135`); the
  table keeps its tab. The RPC already supports it (migration 211:55).
- **Task 4:** debounce the value that drives the **query** (1000 ms), not the visible input; reset
  pagination when the committed search changes; keep contracts list, summary and export on the same
  committed value. Covers contracts, invoices, users, WhatsApp chats **and** contacts
  (`WhatsAppInboxTab.tsx:65`, `WhatsAppContacts.tsx:60`).
- **Task 5:** search by tenant code / name / email / phone **inside the query, before pagination**
  (`useUsers.ts:78-90` searches profile fields only), keeping the user-scope restrictions.
- **Task 6:** tenant name/code links to `/admin/tenants/$id`. Remove the pager on the **tenant tab
  only**, and load all rows with the paged fetch (`fetchAllOffsetPages`) — not `pageSize: 1000`,
  which silently truncates. The tenant-name lookup is itself capped at 1000
  (`admin.settings.users.tsx:95,335`) — page it too.
- **Task 7:** `#` column = `index + 1` over the rendered, sorted rows; update loading/empty
  `colSpan`s; keep row keys on the contact id (`WhatsAppContacts.tsx:131,171`).
- **M13 in this PR:** split `src/hooks/useContracts.ts` (651) keeping range fetch, relation attach
  and export together (`:159`, `:207`, `:326` share one pipeline).
- **Verify in the app:** switch contract tabs → KPIs unchanged; type fast in each search → one
  request after the pause.

### PR 3 — Tenant contact write-back (Task 3) — decided: login email follows
- Server-side only (`createAppUser.ts:195`, `updateAppUser.ts:117`): on save, write email and
  WhatsApp to the linked tenant. Tenant record wins on conflict; blank never clears.
- `updateAppUser` writes GoTrue first, then profiles (`:79`). Adding a tenant write creates a third
  step: define what happens if it fails and **report** it — do not copy the best-effort
  portal-enable pattern for a required write.
- Multiple accounts on one tenant: last saved wins; say so in the UI.

### PR 4 — Gateway settlement safety (before any link-lifetime change)
- First, a **behaviour-only** split of `src/fns/gatewaySettlement.ts` (605) into its parsers and its
  settlement core.
- Then address the known gap: when settlement resumes or skips already-paid months, the original
  PREQ total check is bypassed (`gatewaySettlement.ts:493-530`), so an old multi-month link can
  collect more than it books. Decide and implement how excess captured money is recorded (a credit
  or refund row, never silently dropped).
- **Tests:** overlapping requests, a month paid elsewhere mid-flight, a late callback.

### PR 5 — Payment-link expiry (Task 9)
- Extend the **existing** reuse (`createPayment.ts:333-388`) with an expiry; never loosen the
  amount / method / selection checks.
- The link's age must come from its **last reset**, not `created_at` — the reset replaces the URL but
  keeps the row's creation time (`:373`). Add a `link_issued_at` (or reuse an existing timestamp) set
  on create and reset.
- **Tests:** stale amount, changed method, concurrent create, callback from a superseded URL.

### PR 6 — Insurance consistency, then the contracts column (Tasks 8, 2) — decided: contract deposit
- Database first: one atomic, permission-checked function that keeps the chosen figure in step,
  including delete and moving an insurance row between contracts. Migration applied by hand before
  the code PR. Existing mismatches get a **separate**, reviewed reconciliation.
- Then `ContractsTable.tsx:106`: replace "Type" with the chosen figure, sortable, formatted with
  `formatKwd`. Invalidate contracts, insurance and budget caches.

### PR 7 — Partial payments: read-only totals + INV-0007725 inspection (Task 10)
- Show invoice total and remaining balance read-only in the partial-payment dialog, with a tooltip.
  Keep the edit add-back (`partialPaymentRemaining.ts:22`) and the database lock as the real
  enforcement. Do **not** force `partially_paid`: `balance` is generated, and state follows
  confirmed allocations — forcing it would corrupt paid and zero-paid rows.
- **INV-0007725 / CON-00028:** read-only diagnosis only in this PR — allocations, payment statuses,
  receipts, partial-payment ledger. `recompute_invoice_from_confirmed` sums confirmed allocations
  (migration 153:160); it cannot recreate a missing allocation. Report the defect and the expected
  delta, `pg_dump`, then owner question 3.

### PR 8 — Dashboard schema only (row 2.4, part 1)
- New migration (take the **next free number at merge time**, not a reserved 218):
  `get_dashboard_kpis()` returning all **12** fields the dashboard shows today
  (`useDashboardKpis.ts:6`), with the **same arithmetic**: UTC month lower bound, no upper bound;
  overdue vs partially-paid handled exactly as now (`:31`, `:69`, `:105`). Any correction to the
  maths is a different PR.
- `SECURITY DEFINER` bypasses RLS, so check permissions inside, per domain — HR figures only for
  users who can see HR (see migration 79's summary RPCs). No caller-supplied company id as
  authorisation. `revoke … from public, anon` **and** grant only to `authenticated`.
- SQL test (`TEST_DB_PORT=55329 bun run test:sql`): figures match the current client-side sums on
  the same fixture; a user without HR permission gets no HR figures.
- Hand-add the RPC to `database.types.ts`. Merge (the app does not call it yet), apply on
  production by hand with `ON_ERROR_STOP=1`, checksum, `notify pgrst`.

### PR 9 — Dashboard consumer (row 2.4, part 2)
- Switch the dashboard to the RPC. Verify on production that the numbers match the old page
  exactly before and after.

### PR 10 — Contract PDF typography (Task 11)
- `src/lib/contractBuilder/html.ts`. Cairo is not in the PDF font stack (`documentFonts.ts:28`) or
  the Docker image (`Dockerfile:47`); naming it in CSS does nothing. Ship the font file and declare
  it where the renderer loads fonts.
- Clauses are distributed across five sheets by hand (`html.ts:248`). Bigger text can add pages
  instead of filling them. Decide with the owner whether five pages is a hard requirement; validate
  by rendering long Arabic and English contracts and counting pages.
- "Section titles 22px" = the clause headings; confirm.

### PR 11+ — Remaining M13 splits (behaviour-preserving, one file per PR)
`admin.settings.lists.tsx` (784), `lib/emailTemplates.ts` (672), `hooks/useLandingSettings.ts` (653 —
media / brands / slides / inquiries, `:177`, `:298`, `:499`, `:584`), `admin.settings.notifications.tsx`
(651), `admin.settings.index.tsx` (644), `contracts/ContractFormDialog.tsx` (643),
`contracts/ConcessionsDialog.tsx` (612). Split by responsibility; render or mount-test each screen.

---

## Also found, for the audit report (not this plan)
- The overlapping-PREQ overpayment gap (PR 4) is a pre-existing money finding, not a Phase 2B
  feature. Record it in `FINDINGS.md`.
