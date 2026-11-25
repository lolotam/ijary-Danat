# Danat Al Mustaqbal ERMP — Remaining Tasks

Reviewed against `main` (`864a599`) and production on 2026-10-19. The previous
review (2026-07-14) predated the go-live; its blockers are recorded as done in §1.

**Headline:** the platform is live at https://danat-future.com. Production has
migrations through `246` applied, and all ten scheduled jobs are installed in
`/etc/cron.d/danat-ermp`. The nine daily or ten-minute jobs ran on 2026-10-19;
the monthly `salaries` job last ran on 2026-10-01.

What follows is only what is genuinely _not_ done, plus the owner decisions that
shape it.

---

## 1. Done since the 2026-07-14 review

- **Go-live.** The app runs on the Danat-Future host; see `CLAUDE.md` →
  "Production" and `deploy/README.md`. Secrets live in Dokploy; this file no
  longer tracks them.
- **Cron.** All ten keys of the `JOBS` map in `src/fns/cronJobs.ts` are
  scheduled: `backup`, `contract-expiry`, `gmail-sync`, `log-retention`,
  `notification-drain`, `overdue`, `overdue-reminders`, `payment-reconcile`,
  `salaries`, `scheduled-reports`.
- **Test runner and money-path tests.** Vitest (`bun run test`) plus a
  real-Postgres SQL suite (`bun run test:sql`). Covered: `generateInvoices`,
  `applyAllocation`, `reversePayment`, MyFatoorah webhook signature and replay
  (`myfatoorahWebhook.test.ts`), and the portal's chronological payment rule
  (`createPayment.test.ts`, "createPayment chronological validation").
- **Landing-page contact form (general requests).** `LeasingDialog` sends a
  `request_type: "general"` submission through `submitContactInquiry`, which
  notifies via the `contact-inquiry-received` workflow
  (`src/fns/notifyContactInquiry.ts`); on production that workflow is active
  and targets admin + company. Leasing requests are the gap in §3.
- **`set_invoice_paid` counted reversed money as paid.** Fixed by migration
  `246` (sum filtered to confirmed payments), applied on production 2026-10-18.

## 2. Tests still missing

- [ ] `evaluateOverdue` — the day/grace boundary. `src/fns/evaluateOverdue.test.ts`
      covers only permissions and the RPC call. Unblocked: the rule was decided
      on 2026-10-20 (§5), so the boundary can now be tested (due_date + 1 still
      due, due_date + 2 overdue, for a 1-day grace).

## 3. Smaller gaps

- [ ] **Chronological invoice order is an admission check, not an invariant.**
      Both `set_invoice_paid` and migration 153's deposit settlement refuse to
      settle an invoice while an earlier one is outstanding, but
      `set_invoice_paid(…, false)` can then _unmark_ the earlier invoice and
      leave the later one paid — the unmark branch has no ordering check
      (`246_set_invoice_paid_confirmed_only.sql:122`). Making it a real
      invariant needs a shared contract-level lock protocol across both, plus a
      rule for what unmarking does when later invoices are already settled.
      Next step agreed 2026-10-19: a written spec, reviewed before any code.
- [ ] **CSV deposit import cannot link to a contract or invoice.**
      `bulk_import_phase6` inserts neither column (`149:84`), and the template,
      the Zod schema and the server-side code→UUID resolution are all missing
      too. Imported deposits stay bank-ledger-only, which the owner accepted on
      2026-08-21. The same insert also still drops `deposit_type`, a gap since
      migration 106.
- [ ] **Environment is validated per request, not at boot.** `validateEnv()`
      (`src/lib/env.server.ts`) runs inside the request handler
      (`src/server.ts:69`); a misconfigured Supabase key or `CRON_SECRET` lets
      the server start and then answers every request with the 500 page. The
      MyFatoorah keys are `optional()` in that schema and the email / WhatsApp
      provider keys are not in it at all, so those surface only when their path
      is used. Fail-fast at startup is still open.
- [ ] **Leasing requests from the landing page send no email.** Any
      `request_type` other than `"general"` goes to `submitLeasingInquiry`,
      which only inserts into `leasing_inquiries` — no workflow, no email. Staff
      with access still see new ones in the in-app bell (`InboxBell`, Leads tab).
      Owner approved an admin email for these on 2026-10-20; not built yet.
- [ ] **Default grace period is decided as 1 day but still 0 in code.** The
      default lives in five places: the column default
      (`04_phase2_properties_tenants_contracts.sql:146`), the contract form
      (`src/lib/contractForm.ts:117`), bulk import
      (`src/lib/bulkImportSchemas.ts:227`), and two SQL fallbacks for a caller
      that omits the field — `save_contract_with_units`
      (`coalesce(..., 0)` in `200_save_contract_accepts_increase.sql:78`) and
      `bulk_import_phase6` (`coalesce(r.grace_days, 0)` in
      `149_tenant_civil_ids_and_address.sql:189`). Changing them changes
      production behaviour, so it ships as its own PR; existing contracts are §4.
- [ ] **Civil ID and document retention is decided but not enforced.** The
      policy is in §5. Nothing deletes these files today, and any automatic
      deletion job on production data needs the owner's explicit approval
      before it runs.
- [ ] **Lint warnings (30, non-blocking, 0 errors on 2026-10-19).** Mostly
      `react-refresh/only-export-components`.

## 4. Open questions — decisions needed from the business

- [ ] **Existing contracts under the 1-day grace decision.** Contracts already
      stored with `grace_days = 0` keep it unless they are updated. Needs the
      owner to say whether the new default applies to new contracts only, or
      whether existing ones are moved to 1 (a production data change).
- [ ] **Brand logo** → final colour tokens (currently a placeholder palette).

## 5. Decisions recorded

- **2026-10-19 — retention of civil IDs and documents:** kept for the contract
  term plus 5 years after the contract ends. Audit and notification logs have
  their own configurable window (`set_log_retention`, migration `242`).
- **2026-10-19 — contact form destination:** email to admin through the
  existing `contact-inquiry-received` workflow (wired for general requests,
  see §1; leasing requests still open, see §3).
- **2026-10-20 — contact-form recipients:** admin **and** company, as the
  `contact-inquiry-received` workflow already targets on production; no change.
- **2026-10-20 — overdue grace period:** 1 day by default. The rule stays
  `due_date + contracts.grace_days < current_date`
  (`82_billing_safety_archived_contracts.sql:565`), so with 1 day an invoice
  due on the 1st is still due on the 2nd and overdue from the 3rd. The default
  change is open in §3; existing contracts in §4.
- **2026-08-21 — imported deposits** may stay bank-ledger-only (see §3).

## 6. Out of scope by design — not gaps

- **Phase 8, Dana-bot** — explicitly out of MVP per the plan.
- **Native iOS/Android** — dropped; web-only.
- **Lovable Cloud** — intentionally not enabled; SQL is run manually.
