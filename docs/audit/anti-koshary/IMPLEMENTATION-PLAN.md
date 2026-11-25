# Implementation Plan — correcting the audit findings

**Pass 2.** Companion to [`FINDINGS.md`](FINDINGS.md). **Done 2026-09-23** — every lane shipped except optional row 2.4; see [`PASS2-REPORT.md`](PASS2-REPORT.md) for what landed, where, and what was left.
Each lane is independently approvable — say which lanes you want and they run in the order
below; skip any and the rest still work.

---

## Ground rules for every lane

These are not optional, and they come from what this audit found about the codebase:

1. **Commit per group, never per lane.** A lane is 3–15 commits. A bad one gets dropped
   without losing the good ones.
2. **After each group: build, typecheck, test.** If a group breaks any of them, **revert
   that group and stop** — do not debug forward with the tree in an unknown state.
3. **A green suite is not proof for screen-level work.** Route-level tests barely exist and
   no Zod schema in `src/fns` runs under test. Every lane below says explicitly what must be
   checked **in the running app**.
4. **Behaviour-preserving lanes must not change behaviour.** Where a lane deliberately
   changes what a user sees, it says so, in the terms you care about.
5. **Never touch `src/components/ui/`** (vendored shadcn) except for a specific named bug.
6. **This plan deviates from the anti-koshary skill's prescribed Pass 2 order** (Critical → structural → dependencies → remaining security), and does so deliberately: there are no Criticals, and the structural work here is *not* the most urgent thing — six small behaviour-changing correctness fixes (Lane 1) and the silent-truncation class (Lane 2) affect users today, while the decomposition (Lane 6) affects only the people editing the code. Dependencies run early (Lane 3) because H14 ships to production. Reorder if you disagree; the lanes are independent.
7. **Branch per lane, PR per lane.** Pushing a feature branch does not deploy; merging to
   `main` deploys immediately. Lane 3 and Lane 7 have deploy-order constraints — see below.

---

## Lane 0 · Make the gates work (prerequisite, ~15 min)

Not a fix. Without it you cannot verify anything else.

| Step | Why |
| --- | --- |
| Reinstall dependencies so `node_modules/.bin` is whole | It currently holds **7** entries; `tsc` is missing and `bun run typecheck` fails with "command not found" — which reads exactly like a broken config |
| Confirm `git status --porcelain` is empty | `git reset` is the entire safety net under every lane below |
| Record the baseline: `bun run test` → 3,217 pass / 1 flake; `node node_modules/typescript/bin/tsc --noEmit` → clean | So "did I break it" has an answer |

**Do not use `bun run lint` as a gate** — this working tree produces ~2,148 CRLF/prettier
errors that a fresh worktree does not.

---

## Lane 1 · Correctness bugs a user hits today — **do this first**

Six small changes, the highest consequence-per-line in the audit.
**Fixes:** H1, H2 (money slice), H3, H4, H6 + M11, M6.
**Effort:** ~1 day. **Risk:** low individually; all change observable behaviour, deliberately.

| # | Change | What behaves differently |
| --- | --- | --- |
| 1.1 | **H1** — `throw new Error(...)` on every failure path in `confirmGatewayPayment.ts`; guard `setState` so a non-union value falls back to `"error"` | A tenant whose settlement fails now sees the "could not verify" card instead of a blank one. **Nobody's money moves differently.** |
| 1.2 | **H2 (money slice only)** — `Error` instead of `Response(403)` in the 9 money fns | A denied operator now sees a red error toast instead of a green success toast. Some users will report "new errors" — they are refusals that were always happening. |
| 1.3 | **H3** — delete the two `logAuditForCurrentSession` calls in `useContractCloseouts.ts` | One audit row per write-off/dispute instead of two. **The remaining row is the richer one** (it carries the full before-state). |
| 1.4 | **H4** — export `withJobLock(job, fn)` from `cronJobs.ts`; wrap `runWorkflowNow`'s dispatch | "Run now" during a cron tick now refuses with "job is already running" instead of double-sending. |
| 1.5 | **H6 + M11** — extract `clientAddress()` to `lib/clientAddress.ts` (prefers `cf-connecting-ip`); extract the rate limiter to `lib/publicFormGuard.ts`; use both in the two public endpoints | The public-form rate limit starts actually working. Decide whether the quota is 5 per endpoint or 5 overall. |
| 1.6 | **M6** — make `issues` a list of `{kind: "skip" \| "failure", message}` in `dispatchNotification.ts`; test `kind`, not the word "skipped" | A notification blocked by a missing recipient or disabled provider is now `skipped`, not `failed` — so the drain job stops retrying it 3× and `needs_review` stops filling with configuration problems. |

**Verify in the running app, not just on green tests:**
a sandbox payment that fails settlement (1.1) · reverse a payment as a user without
`payments.reverse` (1.2) · write off an invoice and check `audit_log` has one row (1.3) ·
"Run now" a job twice quickly (1.4) · POST the contact form twice with a forged
`X-Forwarded-For` (1.5) · disable every email provider and queue a notification (1.6).

**Write first:** a test at the `useServerFn` boundary for 1.1/1.2 — the client-side resolve
is runtime TanStack behaviour the `createServerFn` mock does not reproduce, so nothing
currently catches a regression.

---

## Lane 2 · Stop the silent truncation

**Fixes:** H11, H10, M19. **Effort:** ~1 day. **Risk:** low — the helper already exists and
is tested.

| # | Change |
| --- | --- |
| 2.1 | **H11** — route all eight CSV exports through `fetchAllPages` (`lib/pagedQuery.ts`). Delete the `500`/`5000` magic numbers. If you want a safety ceiling, make it **one** exported constant and render the `listTruncated` banner on the export button too |
| 2.2 | **H10 (a)** — wrap `admin.index.tsx:69`'s invoices read in `fetchAllPages`. One line, immediate |
| 2.3 | **M19** — call `assertNotRowCapped` on every **unranged** read: `attachTenantLocations`'s four, and the remaining list reads that carry no `.range()`. It guards only 3 of ~20 today. Note it **throws** — that is deliberate per its docblock, but it must not be applied to a ranged page query, where returning exactly `pageSize` rows is normal |
| 2.4 | **H10 (b), optional but better** — replace the dashboard's nine round trips with one RPC returning the sums and counts. Needs a SQL test (`bun run test:sql`, `TEST_DB_PORT=55329`) |

**Write first:** one test per export asserting a dataset larger than the cap comes back
whole. This is the cheapest possible regression guard and it is what was missing when six of
eight exports drifted.

**Verify:** export a list with more rows than its old cap and count the lines.

---

## Lane 3 · Dependencies and the build

**Fixes:** H14, M36, M35, L3. **Effort:** ~2 hours. **Deploy-sensitive.**

| # | Change |
| --- | --- |
| 3.1 | **H14** — `bun update nodemailer`. The fix is **inside** the declared `^9.0.3` range, so no major bump. Re-run `npm audit --omit=dev` to confirm it clears |
| 3.2 | **Ask before doing:** if the Resend migration made SMTP permanently unused, **removing** nodemailer beats patching it. Check whether any `provider_configs` row still has `smtp` enabled |
| 3.3 | **M36** — bump `vitest` past 4.1.10 (patch, in range). Build/test only |
| 3.4 | **M35** — delete `\|\| bun install` from `Dockerfile:5`. A frozen-lockfile failure is the signal; the fix is to commit the updated lockfile |
| 3.5 | Patch and minor bumps for the ~28 `@radix-ui/*` packages, in **one** commit, then build + test |

**Do NOT apply on your own initiative — listed for your decision (L3):**
`@eslint/js` 9.39.4 → **10.0.1** (major; flat-config API changes) ·
`@lovable.dev/vite-tanstack-config` 2.7.6 → **2.23.1** (16 minors on the build config —
deserves its own PR and a careful look at the produced bundle).

**Verify:** `bun run build` must succeed **after 3.4** — that change is precisely what makes
a lockfile mismatch fail loudly, so it is the one commit whose verification is the next
deploy build.

---

## Lane 4 · Finish the sweeps that were started

This is the lane that actually removes the koshary. Every item is a rule the codebase
already decided and applied partially. **All of it is behaviour-preserving** except 4.1's
tail, which is flagged.

**Fixes:** H2 (remaining 24 files), M3, M1, H12, M17, M18, M4, M7, M12, M15, M16, M33, M5, L1.
**Effort:** ~3–4 days. **Risk:** low per commit, high volume — hence one commit per sweep.

| # | Sweep | Size |
| --- | --- | --- |
| 4.1 | **M3 + H2 tail** — one `requirePermission(context, code, attempted, entity?)` that runs the RPC, records the denial, and throws an `Error`. Apply to all 48 `src/fns` files in one pass | 48 files, −~500 lines. *Behaviour change:* denials are now recorded in `permission_denials` from every fn, not 9 |
| 4.2 | **M1** — `roundToFils` in a new `lib/fils.ts` (**not** `money.ts` — that module's display/precision line is deliberate). Replace 8 sites | 8 files |
| 4.3 | **H12** — promote `emailTemplates.ts:203`'s `escapeHtml` to `lib/html.ts`; delete the other five | 6 files. *Behaviour change:* apostrophes now escaped in 3 more places — correct and invisible |
| 4.4 | **M17 + M18** — one `ARABIC_FONT_STACK` and one `ARABIC_SAFE_CSS` constant; six and two imports. Decide separately whether the email stacks gain an Arabic face (**decision 5**) | 8 files. **Verify by looking at a generated PDF and a received email, not by test** |
| 4.5 | **M4 + M7** — senders return `benign: boolean` and an `alreadyNotified()` helper that **throws** on a query error instead of failing open | 9 + 5 files |
| 4.6 | **M12** — delete the 13 `as any` from RPCs that are typed, run typecheck. If one genuinely fails, that is a real types-drift finding to report, not suppress | 13 sites |
| 4.7 | **M15** — move `FilterSelect` and `Field` into shared components | −60 lines |
| 4.8 | **M16** — add `console.error(…, error)` beside the ten `toast.error` catches | 10 one-line additions |
| 4.9 | **M33** — `providers/smtp.ts` uses `stripMarkup`. *Behaviour change:* the text part of SMTP email gets correct line breaks and decoded entities | 1 file |
| 4.10 | **M5 + L1** — either surface `notificationWarning` via a reason **code** (never the English string) or delete the two unread computations; delete `getAdminNotificationEmails` **and its twelve test mocks in the same commit** | 14 files |

**Verify:** typecheck after each; 4.4 and 4.9 by eye on real output; 4.1 by attempting one
denied action per permission family.

---

## Lane 5 · i18n consolidation (H9)

**306 strings** into `dictionary.ts`. **Effort:** ~2 days. **Risk:** lowest of any large
change in this audit — `dictionary.test.ts` verifies each batch as you go, so **the suite
gets stronger with every commit**.

Order by concentration; one commit per file:

1. `admin.settings.landing-page.tsx` (57) — do with Lane 6's split of the same file
2. `routes/index.tsx` (53) — do with Lane 6's landing-page extraction
3. `admin.settings.roles.tsx` (32) — **skip if decision 2 deletes custom roles**
4. `components/admin/landing-page/*` (37 across 4 files)
5. `ownedPageKpis.tsx` (18), `dashboardCards.tsx` (13), `admin.index.tsx` (9)
6. `lib/invoicePrintHtml.ts` (9), `lib/closeoutStatement.ts` (7) — **printed documents a
   tenant receives; check a rendered document after this one**
7. the remaining ~10 files, 1–7 each

**Do not attempt all 306 in one commit.** Note `dictionary.ts` passes 5,000 lines here; if
you split it, split **by locale** (`ar.ts`/`en.ts`) so the parity test keeps working (L4).

---

## Lane 6 · Component decomposition — the big one

**Fixes:** M13, M27, M29, M30, M9, M2, M32. **Effort:** ~1–2 weeks.
**Risk:** the highest in this plan, entirely because of missing test cover — not because the
changes are hard. **No behaviour changes at all.**

Ordered by value ÷ risk:

| # | Target | Into |
| --- | --- | --- |
| 6.1 | `ScheduledAndGeneratedReports` (M27) | Two panels — child tables already extracted. **Easiest; do it first to establish the pattern** |
| 6.2 | `ChargesTab` (M30) | Extract `<GenerateChargesDialog>` (5 state vars). **Two period selections in one scope, one of which generates money** |
| 6.3 | `InvoicesTable` + `InvoiceRowsTable` (M29) | Move dialog *state* into the dialog components that already exist |
| 6.4 | `admin.settings.users.tsx` (M13) | Four dialogs → `components/admin/users/`. ~700 lines out |
| 6.5 | `admin.payments.tsx` `FullPaymentsPanel` (M13) | `PaymentsTable`, `CreatePaymentDialog` (owns `settleInvoices`), `AllocationDialog`, `ReversalDialog` |
| 6.6 | `admin.inbox.tsx` `InboxPage` (M13) | 762 lines / 19 `useState`; `components/admin/compose/` is the destination |
| 6.7 | `admin.settings.landing-page.tsx` (M13) | `SlidesPanel`, `GalleryPanel`, `SectionsPanel`, `LandingTextForm` → `components/admin/landing-page/`. **Do Lane 5 step 1 in the same pass** |
| 6.8 | `routes/index.tsx` `LandingPage` (M13) | One component per `<section>` → `components/landing/` (which exists and holds 120 lines). ~1,400 lines move. **Do Lane 5 step 2 in the same pass** |
| 6.9 | `CloseoutWizard` (M13) | One component per step; the wizard keeps `step`, the form and `success`. **Five `useEffect` in one scope — the riskiest of the eight** |
| 6.10 | `dispatchNotificationRecord` (M9) | `sendEmailChannel` / `sendWhatsAppChannel`, each returning `{messageIds, issues, provider, senderAddress}`; hoist the duplicated opt-out guard |
| 6.11 | `myfatoorahWebhook.ts` (M2) | `fns/gatewaySettlement.ts` + `lib/myfatoorahSignature.ts`. **`valueAtPath` and `nestedString` must NOT be merged** — the file explains why at `:164-172` |
| 6.12 | `TenantDocumentsManager` (M28), `MaintenancePage`, `PropertiesPage`, `EmployeesPage`, `TenantsIndexPage`, `ExpensesPage` (M13) | Same shape. Lowest priority |
| 6.13 | **M32** — extract `lib/{payment,expense,deposit,maintenance}Form.ts` following the existing four | **Do this as part of 6.5 and 6.12** — the schema falls out naturally when the dialog moves |

**The model already exists in this repo:** `components/admin/whatsapp/` — 22 files, 125 lines
average. Point at it rather than inventing a convention.

**Verify:** typecheck after every commit, and **open the screen**. Nothing asserts that the
KNET dialog still opens or that the close-out wizard advances.

---

## Lane 7 · Move rules to where they can be enforced

**Fixes:** H8, H7, M22. **Effort:** ~3 days. **Risk:** these change what the server accepts
and what the cache holds. **Write the tests first.**

| # | Change | Note |
| --- | --- | --- |
| 7.1 | **H8** — move `isContiguousPrefix` into the **user-scoped server fn** `fns/applyAllocation.ts`. Give the three browser comparators one shared `(year, month, code)` function | The documented objection — that a check in the RPC would strand gateway money mid-webhook — **does not apply to the server fn**, which the webhook never reaches. *Behaviour change:* out-of-order allocation now refused server-side |
| 7.2 | **M22** — promote `lib/portalQueryKeys.ts` to cover all six `portal-*` keys with one `invalidatePortalViews()`; call it from every hook that invalidates `invoices` or `payments`; replace the two inline arrays. **Leave the `insurance_payments` key-nesting alone** — unpicking it reintroduces the bug its comment describes | Additive; the only risk is an extra refetch |
| 7.3 | **H7** — `resolveCompany(companyId)` reading by id where the caller has one, falling back to `order("created_at").limit(1)`. 23 sites | **The cheap half first, on its own:** make the 8 unordered `.limit(1)` reads ordered. Five minutes, removes the non-determinism, worth doing even if the rest is declined |

**Deploy order matters for 7.1:** it changes what the server accepts. Merge it when someone
is available to watch the payments screen.

---

## Lane 8 · Your decisions (nothing happens until you answer)

| Decision | Blocks |
| --- | --- |
| **H5** — account management: admin-only, or permission-driven? | A one-file change either way |
| **H7 / M24** — is a second company expected? should custom roles exist? | Lane 7.3's scope; whether to delete ~850 lines; whether a SQL-scoped RLS review is needed first |
| **M14** — is `contractual_monthly` a real expense class? | A CSV importer change or a UI change |
| **M10** — block a manual send with unresolved variables, or extend `resolveTypeVariables`? | One line vs. real work |
| **M17** — should email font stacks gain an Arabic face? | Lane 4.4's tail |

---

## Suggested sequence

```
Lane 0  (prerequisite, 15 min)
  └─ Lane 1   correctness bugs users hit today        ~1 day    ← start here
     └─ Lane 2   stop the silent truncation           ~1 day
        └─ Lane 3   dependencies + build              ~2 hours
           └─ Lane 4   finish the started sweeps      ~3–4 days
              ├─ Lane 5   i18n consolidation          ~2 days   ┐ share files —
              └─ Lane 6   component decomposition     ~1–2 wks  ┘ run together
                 └─ Lane 7   move rules to the server ~3 days
Lane 8  decisions — answer any time; Lanes 6.7/6.8 and 7.3 wait on them
```

**If you only do one thing:** Lane 1. Six small changes, and every one of them fixes
something a user experiences today.

**If you only do two:** Lane 1 and Lane 2. Together they cost two days and close every
finding where the software currently gives a wrong answer without saying so.

---

## What Pass 2 must not do

- Touch `src/components/ui/` (vendored shadcn)
- Merge `lib/adminTableSortValues.ts`'s 13 switches (13 row shapes, 13 owners — merging needs
  a discriminator per caller)
- Merge the three HTML document shells (email / browser-print / Chromium-PDF — three
  renderers, three constraint sets)
- Merge the ten CRUD hooks (boilerplate; only the export cap was coupled, and Lane 2 fixes it)
- Merge `valueAtPath` with `nestedString` in `myfatoorahWebhook.ts`
- Merge `loadTemplateCopy` with `loadTemplateChannel` (they degrade in opposite directions on
  `is_active`, deliberately)
- Rename query-key prefixes for consistency (checked: no actual mis-invalidation; churn
  without a consequence)
- Act on the out-of-boundary database concerns without a SQL-scoped review first
