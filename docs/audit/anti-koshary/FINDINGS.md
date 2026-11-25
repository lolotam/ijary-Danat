# Anti-Koshary Audit — Final Report

**Danat Al Mustaqbal ERMP** · 2026-09-22 · **Pass 1 report.** Pass 2 fixed these on 2026-09-23 — see [`PASS2-REPORT.md`](PASS2-REPORT.md), which also records where this report was wrong (H14, `warnIfClipped`).

**All 18 scopes audited — 118,431 production lines across ~1,112 files.**
Per-scope reasoning: [`PLAN.md`](PLAN.md) · cross-scope duplication: [`LEDGER.md`](LEDGER.md) ·
what to do about it: [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md)

---

## The headline

This is not a badly written codebase. It is a **well-written codebase that has drifted**.

Almost every finding below follows the same shape: a problem was diagnosed, correctly,
often after a real incident — and the fix landed in one, two or six places out of thirty.
The reasoning is usually still there in a docblock, explaining precisely why the thing you
are looking at is wrong somewhere else.

> `deleteAppUser.ts:13-19` explains that a thrown `Response` resolves as success. **33 files
> still throw one.**
> `cronJobs.ts:63-72` records the September incident that needed a concurrency lock.
> **"Run now" doesn't take it.**
> `idChunks.ts:34` explains that an unranged query is silently clipped at 1,000 rows.
> **The dashboard's money KPIs are one.**

So the work ahead is mostly *finishing sweeps that were started*, not redesigning anything.
That is the good news, and it is why the implementation plan is ordered the way it is.

### What is genuinely excellent

Recorded so Pass 2 does not disturb it: `src/lib` (60 files, none over 450 lines, each one
job); `components/admin/whatsapp/` (22 files averaging 125 lines — the decomposition model
for the rest of the repo); the four public API routes (7–11 lines of pure delegation);
`workflowRegistry.ts` and `cronJobs.ts`; `statusTone.ts`, `queryRetry.ts`, `money.ts`,
`dictionary.test.ts`; and the authorization coverage — **every mutation in this codebase is
gated.**

---

## Counts

| Priority | Count |
| --- | --- |
| **Critical** | **0** |
| **High** | **14** |
| **Medium** | **30** |
| **Low** | **4** |

**Security: clean.** No secrets in the working tree, and none in git history for the patterns checked. No `eval`, no CORS
wildcards, no SQL concatenation, no auth tokens in `localStorage`, no secrets in logs. The
one XSS sink is DOMPurify-sanitised on write *and* on render. One runtime dependency
vulnerability (H14), fixable inside its existing version range.

---

## Baseline

| | |
| --- | --- |
| Stack | TypeScript · React 19 · TanStack Start + Nitro · Vite 8 · Tailwind 4 + shadcn · self-hosted Supabase (Postgres 17) |
| Package manager | **Bun** — `bun.lock` is tracked and is what the Dockerfile uses. `package-lock.json` is gitignored on purpose (`.gitignore:85-86`) |
| Tests | 349 files / 3,220 tests · **3,217 pass**, 1 IO-timeout flake, 2 skipped → green |
| Typecheck | **clean** — but `bun run typecheck` fails here: `node_modules/.bin` holds 7 entries and `tsc` is missing. Use `node node_modules/typescript/bin/tsc --noEmit` |
| Lint | not a gate — ~2,148 CRLF/prettier errors local to this working tree only |
| Working tree | clean at audit start; must be clean again before Pass 2 |

**The test caveat that governs every "safe" claim below:** the shared `createServerFn` mock
never runs `.validator()`, so **no Zod schema in `src/fns` executes under test**. Route-level
tests barely exist. A green suite proves the libs and hooks work; it proves very little about
the screens.

---

## High (14)

### Money and payments

**H1 · A failed gateway settlement shows the tenant a blank page.**
`fns/confirmGatewayPayment.ts:151,254,274,286,316,361` → `routes/portal_.payments.callback.tsx:117-128`
· [S01](01-fns-money.md)
Throws `Response` on every failure. TanStack marks it `x-tss-raw`; the client **resolves**
it, so `setState(result.status)` gets the number `500`, which matches none of the seven
`CallbackState` branches — and `onError` never runs. The card was charged, the invoice is
unpaid, and the page renders its title and two nav buttons. Nothing else.

**H2 · Eight money server fns report a permission denial as success.**
`applyAllocation:34` `reversePayment:29` `evaluateOverdue:39` `generateInvoices:30`
`backfillContractInvoices:35` `regenerateContractInvoices:85` `generateElectricityCharges:22`
`confirmGatewayPayment:254` `myfatoorahGateway:13` · [S01](01-fns-money.md)
`admin.payments.tsx:419-428` fires `toast.success("payments.reversed")` after a refusal.
A client-side `permissions.can()` pre-check masks it when client and server agree — and does
nothing for `myfatoorahGateway`, where an unset API key resolves as success and the portal
redirects to `undefined`. **Repo-wide: 33 files.**

**H3 · Every write-off and dispute writes two audit rows, under two different names.**
`hooks/useContractCloseouts.ts:291-297,314-322` vs `db/migrations/86_….sql:88,155,215`
· [S01](01-fns-money.md)
The RPC audits; the hook audits again from the browser. Clear-dispute produces
`invoice.dispute_clear` (SQL) **and** `invoice.clear_dispute` (browser) — a report keyed on
one name misses half the events. This is the exact defect removed from `useReversePayment`
in PR #206, left in place two hooks over.

**H8 · "Settle oldest first" is implemented six times, and on the admin payment path it lives only in the browser.**
`routes/admin.payments.tsx:364` · [S04](04-routes-money.md)
`apply_payment_allocation` — the RPC that path calls — has **no** ordering check, by a
documented deliberate choice (the webhook shares it). So anyone with `payments.create` can
settle out of order via `applyAllocation` and nothing records it. Separately, of the six
comparators, two have **no tiebreak at all**, so two screens can name different "oldest"
invoices.

### Data correctness

**H10 · The dashboard's money KPIs silently stop being correct at 1,000 invoices.**
`routes/admin.index.tsx:69` · [S05](05-routes-admin.md)
`supabase.from("invoices").select(...)` with no `.range()`, summed in the browser.
`PGRST_MAX_ROWS = 1000` clips it silently. At ~70 units the portfolio generates ~840
invoices a year — **the cap is crossed in about 14 months**, and it arrives as "the
dashboard disagrees with the invoices page" with nothing in the logs.

**H11 · Every CSV export silently truncates, at four different limits.**
[S16](16-hooks-a.md)

| Export | Returns | Export | Returns |
| --- | --- | --- | --- |
| Deposits, Expenses | **1,000** (PGRST clips a requested 5000) — cap per `idChunks.ts:29`; **not re-verified against the running PostgREST** | Tenants, Contracts, Units, Properties, Buildings, Maintenance | **500** |
| Reports, Invoices | complete ✓ | | |

Six magic numbers, no shared constant, no warning banner — while the list screen beside each
export *does* show one. The two that are complete are the two that were fixed after
incidents.

**H7 · "Which company are we" is answered 23 times, in two incompatible ways.**
[S03](03-fns-platform.md)
15 sites use `.order("created_at").limit(1)`; **8 use `.limit(1)` with no `ORDER BY`**, which
in Postgres returns an undefined row. Two read correctly by `company_id`. One of the
unordered readers is `lib/paymentReceiptPdf.ts:276`, which selects `*` to print the company
header **on a receipt**. Nothing is wrong with one company row — the cost already paid is
that the rule cannot be corrected in fewer than 23 edits and has already drifted unnoticed.

### Correctness of enforcement

**H4 · The admin "Run now" button bypasses the double-fire lock an incident added.**
`fns/cronJobs.ts:73` (module-private) vs `fns/runWorkflowNow.ts:86-99` · [S03](03-fns-platform.md)
`cronJobs.ts:63-72` records the 2026-09-01/02 incident — two concurrent runs both read "no
reminder yet this month", both enqueued, and the doubled WhatsApp burst preceded the device
being unlinked. `runWorkflowNow` mirrors the pause check, the timing and the recording. It
misses only the lock.

**H5 · The Users screen offers three buttons the server refuses.**
`routes/admin.settings.users.tsx:103-106` vs `createAppUser:121` `updateAppUser:41` `deleteAppUser:31`
· [S03](03-fns-platform.md)
UI gates Create/Edit/Delete on `users.create/update/delete`; the server requires
`has_role('admin')`. The Active toggle beside them honours the permission correctly.
**Needs your decision** — see below.

**H6 · Both public rate limits are trivially bypassable.**
`submitContactInquiry.ts:50-53`, `submitLeasingInquiry.ts:46-49` · [S03](03-fns-platform.md)
Keyed on `x-forwarded-for`, which Cloudflare and Traefik **append** to — so the first element
is whatever the client sent. A rotating forged header gets a fresh bucket per request.
Each accepted submission inserts a row **and mails the admin**, making it an
email-amplification vector. `loginAudit.ts:61-73` already documents `cf-connecting-ip` as the
header to trust, and is not reused.

### Correctness of rendering and delivery

**H9 · 306 user-facing strings bypass the i18n dictionary and its enforcement test.**
[S06](06-routes-settings.md)
`locale === "ar" ? "…" : "…"` — 57 in `admin.settings.landing-page.tsx`, **53 in
`routes/index.tsx` (the public marketing page)**, 32 in `admin.settings.roles.tsx`, 94 in
the landing-page feature overall, 16 in printed documents a tenant receives.
`dictionary.test.ts` asserts locale parity, that every `t("literal")` resolves, and that
every interpolated family exists. These 306 are outside all three, and they hard-code the
set of supported locales in 306 places.

**H12 · `escapeHtml` is implemented six times, three of them weaker.**
[S13](13-lib-documents.md)
Three escape `'`, three do not; five are named `escapeHtml` and three are module-private, so
nothing at a call site says which you have. **Verified not exploitable today** — there are
zero single-quoted interpolated attributes in `src/lib`. But this is the XSS boundary for
admin-authored template bodies and tenant data, and one `style='…'` away from mattering.

**H13 · Six of ten outbound HTTP callers have no timeout — including every notification provider.**
[S14](14-lib-providers.md)
`providers/{resend,postora,twilio,whatsapp}.ts` and `gmailClient.server.ts` use a bare
`fetch`; `providers/smtp.ts` accepts nodemailer's defaults (up to 10 minutes on a hung
socket). `fns/myfatoorahGateway.ts:18-24` spells out the consequence — *"the request hangs
for as long as the socket stays open… the caller's UI waits forever"* — and that lesson
reached the payment gateway and none of the five senders. A provider that accepts a
connection and stops replying stalls the whole notification drain batch.

### Dependencies

**H14 · `nodemailer` 9.0.3 — four advisories, ships to production.**
[S18](18-repo-wide.md)
Two are recipient-domain validation bypasses (delivery to an attacker-controlled domain),
one bypasses `disableFileAccess`/`disableUrlAccess`, one is an O(n²) DoS. Exposure needs
someone who can set a tenant's email — which is any operator with `tenants.update`.
**The fix is inside the declared `^9.0.3` range.**

---

## Medium (26)

Grouped by theme; each links to its scope report.

### Duplication that will drift

| # | Finding | Count |
| --- | --- | --- |
| M1 | The fils rounding rule (`Math.round(v*1000)/1000`, "match `numeric(14,3)`") re-derived under 4 names. `lib/money.ts` is display-only by design and has no home for it. [S01](01-fns-money.md) | 8 sites |
| M3 | The `has_permission` + deny preamble, in **three incompatible variants**; only 9 record the denial, and **no file both records it and reports it correctly**. [S01](01-fns-money.md) | 48 files |
| M4 | "Which notification skip is benign" written against string literals the callers don't own, with a **divergent sixth list** in `WorkflowTable.tsx:45`. [S01](01-fns-money.md) | 5 + 1 |
| M7 | The "already notified?" guard, all **fail-open on a query error** — a transient fault sends a duplicate admin email. [S02](02-fns-notifications.md) | 9 files |
| M8 | The notify-sender family: `notifyInvoiceWrittenOff` and `notifyInvoiceDisputed` differ in **~20 substantive lines out of 158**. M4, M7 and H2 each need a nine-file sweep because of it. [S02](02-fns-notifications.md) | 9 files |
| M11 | `submitContactInquiry` / `submitLeasingInquiry` duplicate the rate limiter verbatim — **separate Maps**, so the quota is 10/hour not 5. Makes H6 a two-file fix. [S03](03-fns-platform.md) | 2 files |
| M15 | `FilterSelect` **byte-identical** in two route files; `Field` near-identical in two more. Deposits and Expenses are adjacent sidebar pages. [S04](04-routes-money.md) | 4 files |
| M17 | **Six different Arabic font stacks** across five renderers — Noto *Naskh* Arabic in the server PDF, Noto *Sans* Arabic in browser print, and **no Arabic face at all** in the email body, email message and signature. [S13](13-lib-documents.md) | 6 values |
| M18 | The load-bearing `* { letter-spacing: normal !important }` Arabic glyph-joining fix stated three times — and **contradicted** by two files in the same directory that set non-zero letter-spacing. [S13](13-lib-documents.md) | 3 + 2 |
| M22 | Portal-preview cache invalidation solved **four separate ways**, covering a minority of admin mutations. Recording a payment, reversing one, marking paid, writing off, disputing and closing out all leave the preview stale. [S17](17-hooks-b.md) | 4 mechanisms |
| M32 | The `lib/<entity>Form.ts` convention followed by 4 entities (contract, property, tenant, unit) and **skipped by 4** (payment, expense, deposit, maintenance), whose schemas live inside 587–924-line route components. [S15](15-lib-helpers.md) | 4 gaps |

### Layer collapse and size

| # | Finding |
| --- | --- |
| M2 | `myfatoorahWebhook.ts` (972 lines) is five modules: normalization, signature verification, idempotency, **the settlement engine**, and HTTP transport. A cron job and the portal callback both import the settlement engine out of an HTTP webhook module. [S01](01-fns-money.md) |
| M9 | `dispatchNotificationRecord` — **225 lines, five levels of nesting**, with the reminders-disabled guard written **twice inside the same function**. [S02](02-fns-notifications.md) |
| M13 | **Thirteen components over 500 lines**, each holding 9–19 independent pieces of state. The worst: `routes/index.tsx` **1,922** (the public landing page, 12 sections, 7 `useEffect` with raw DOM side-effects) · `admin.settings.landing-page.tsx` **1,052** · `admin.contracts_.$id.closeout.tsx` **989** · `admin.payments.tsx` **924** · `admin.inbox.tsx` **762** (19 `useState`). Plus `admin.settings.users.tsx` at **1,421 lines** across six components. **This is the largest maintainability liability in the codebase, and fixing it changes no behaviour.** [S04](04-routes-money.md) [S05](05-routes-admin.md) [S06](06-routes-settings.md) [S07](07-routes-portal-public.md) |
| M27 | `ScheduledAndGeneratedReports` — two screens in one component (12 `useState` in two disjoint sets), and its name says so. Its child tables are already extracted. [S09](09-components-admin-b.md) |
| M29 | `InvoicesTable` (569) and `InvoiceRowsTable` (525) each hold a table **plus five dialogs' state**; the dialogs already exist as separate components. [S10](10-components-money.md) |
| M28 | `TenantDocumentsManager` (554 lines) — the largest component outside `src/routes`: list, upload, inline rename, delete, preview and multi-select in one body. Its sibling `TenantDocumentShareDialogs` is already split out, so the intended direction was there. [S09](09-components-admin-b.md) |
| M30 | `ChargesTab` (420 lines, 12 `useState`) holds a filter bar **and** a generation wizard — with **two separate period selections** in one scope, one of which triggers a money-generating action. [S11](11-components-messaging.md) |

### Wrong or discarded information

| # | Finding |
| --- | --- |
| M6 | **A notification's terminal database state is decided by substring-matching English prose** — `issues.some(i => i.includes("skipped"))`. Three reachable messages lack the word, so a missing recipient or a disabled provider is written `failed`, retried 3× by the drain job, and parked in `needs_review` as a delivery failure. Two shared constants already lack it. [S02](02-fns-notifications.md) |
| M10 | A manual send of any of ~12 non-covered notification types mails **blank placeholders**; the `missing[]` warning is an amber panel with no effect on the send button. [S02](02-fns-notifications.md) |
| M14 | Editing an imported expense **silently rewrites its classification**. `class` is derived from `recurrence` on every save and can produce only 3 of the enum's 4 values; the CSV importer accepts all 4. Budget reports group by `class`. [S04](04-routes-money.md) |
| M16 | **Ten** `catch { toast.error(…) }` sites on the PDF / print / bulk paths that discard the error object. When a deploy 404s the lazy chunks — a documented failure mode here — this is the toast the user sees, and the one artifact naming the cause is thrown away. [S08](08-components-admin-a.md) |
| M5 | `notificationWarning` is built on every close-out, sent over the wire, and **read by nobody** in two fns; the two callers that do read it test only truthiness. [S01](01-fns-money.md) |
| M19 | `assertNotRowCapped` — the detector written for H10/H11 — guards only **3** of ~20 unranged reads. Plus four more unbounded reads behind the tenants list. [S05](05-routes-admin.md) |
| M33 | `providers/smtp.ts:29` builds the plain-text alternative with `replace(/<[^>]+>/g, " ")` while `stripMarkup` — exported, two files away — exists **because that crude version already shipped broken output to tenants**. [S14](14-lib-providers.md) |

### Other

| # | Finding |
| --- | --- |
| M12 | **Thirteen `as any` casts on RPCs that are fully typed** (`has_permission` at `database.types.ts:2103`, `has_role` at 2332). A renamed parameter would compile and fail silently as a denied permission. [S03](03-fns-platform.md) |
| M23 | One public form, **three schemas**, none authoritative: the client has no length caps and the `"general"` branch validates against the *leasing* schema before posting to the *contact* endpoint, where `message` is required. [S07](07-routes-portal-public.md) |
| M24 | ~850 lines of UI and hook for the custom-roles feature, whose tables **were never applied in production** (migration 16) and are absent from `database.types.ts` — so all 11 query sites are `as never` and nothing in that hook typechecks. [S06](06-routes-settings.md) |
| M35 | `Dockerfile:5` — `RUN bun install --frozen-lockfile \|\| bun install`. The `\|\|` turns a deliberate lockfile-mismatch failure into a **silent fresh resolution**, so an image can be built from dependency versions that were never tested. [S18](18-repo-wide.md) |
| M36 | `@vitest/mocker` path-traversal advisory (build/test only — does not ship). [S18](18-repo-wide.md) |

---

## Low (4)

| # | Finding |
| --- | --- |
| L1 | `getAdminNotificationEmails` is **dead production code** kept alive by twelve test mocks, while the code under test calls `resolveNotificationRecipients`. Verified not dynamically reached. [S02](02-fns-notifications.md) |
| L2 | `CLAUDE.md:45-46` names `admin.contracts.tsx` (~1470 lines) and `admin.invoices.tsx` as "known offenders to split". They are now **457** and **524** — both already split — while the thirteen real offenders (M13) are named nowhere. [S18](18-repo-wide.md) |
| L3 | ~28 `@radix-ui/*` packages 4–10 minors behind (all inside declared ranges); `@eslint/js` one major behind; `@lovable.dev/vite-tanstack-config` 16 minors behind. **Not a security finding.** [S18](18-repo-wide.md) |
| L4 | `dictionary.ts` (4,546 lines) will pass 5,000 when H9's 306 strings land. If it is ever split, split **by locale** — the parity test compares the two objects and keeps working. [S18](18-repo-wide.md) |

---

## Five decisions only you can make

Pass 2 must not guess at any of these.

1. **H5 — account management: admin-only, or permission-driven?** The catalogue and the
   server disagree. Either drop `users.create/update/delete` from `PERMISSIONS` and gate the
   screen on `has_role('admin')`, or switch the three server fns to `has_permission`.
2. **H7 / M24 — is a second company ever expected, and should custom roles exist?** If yes to
   the first, the 23-site company consolidation is mandatory rather than optional. If yes to
   the second, apply migration 16; if no, delete ~850 lines.
3. **M14 — should `contractual_monthly` be a real expense class** (extend the UI) or should
   the importer stop accepting it? Today it can be written and cannot survive an edit.
4. **M10 — block a manual send while variables are unresolved, or extend
   `resolveTypeVariables` to the remaining ~12 types?** One line versus real work.
5. **M17 — should the email font stacks gain an Arabic face?** They probably should, but mail
   clients are conservative about fonts and this is a presentation judgement.

---

## Out of boundary — flagged, not audited

The scope agreed at Step 0 was `src/`. Two database-level concerns recorded by the project's
own notes were **not verified**: multi-company isolation is not enforced in RLS (`company_id`
on 32 tables, no staff policy uses it), and `revoke … from public` does not remove
`anon`/`authenticated` grants that some `SECURITY DEFINER` functions may still carry.
**Neither is a finding of this audit.** If decision 2 above is "yes", both need a
SQL-scoped review before a second company is onboarded.

---

## Next

[`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) sequences all of this into lanes, with an
explicit stop-and-confirm gate after each. **Pass 2 begins only on your approval, and only
for the lanes you approve.**
