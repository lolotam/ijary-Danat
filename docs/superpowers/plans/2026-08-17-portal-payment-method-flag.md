# Admin-controlled portal payment methods — implementation record

**Status:** implemented. This file records what was built and why, task by task.
Design: `docs/superpowers/specs/2026-08-17-portal-payment-method-flag-design.md`.

**Goal:** Let an admin choose whether the tenant portal offers Apple Pay and
Google Pay alongside KNET. KNET is always available. When only one method is
effective, "ادفع الآن" goes straight to that provider with no dropdown.

**Architecture:** Two boolean columns on `companies`, defaulted `true` so the
deploy is a no-op. The effective set is `enabled ∩ device-capable`, computed by
two pure functions in `src/lib/paymentHandoff.ts` and consumed by `PayNowMenu`,
by `paySelected`, and by the tests. `createPayment` enforces the same set
server-side for tenant-initiated payments only. The admin surface is a
form-context card sharing the settings page's existing save button.

**Tech Stack:** TanStack Start (React 19), TypeScript, Tailwind CSS 4,
shadcn/ui (Radix), Vitest, Bun, self-hosted Supabase (Postgres 17).

## Constraints that shaped the work

- **Arabic doc comments** lead every function, English only for the *why*.
- **Exact MyFatoorah strings:** `KNET`, `GOOGLE_PAY`, `APPLE_PAY`, with
  underscores. Now additionally enforced by
  `satisfies Record<HostedPaymentMethod, …>` on the presentation map, and still
  pinned by a source assertion because typecheck is a separate gate from the suite.
- **`throw new Error`, never `throw new Response`** — a thrown `Response`
  resolves client-side as success via `x-tss-raw`.
- **No rule in `.validator()`** — the `createServerFn` mock never runs it.
- **i18n parity is enforced** by `src/i18n/dictionary.test.ts`; all four new keys
  were added to both locales in the same edit.
- **`t()` takes no parameters** (`src/i18n/provider.tsx:23`), so the
  single-method button label is composed in JSX.
- **`database.types.ts` is hand-maintained** — edited by hand in Row, Insert and
  Update; `gen:types` was not run.
- **File-size ceiling 500–600 lines.** `admin.settings.index.tsx` was already 660
  and over it, which is why the card is a separate component and the route file
  grew by only an import, two schema fields, two defaults, two loads and one
  placement — 660 → 670 lines. `PayNowMenu.tsx` is 124 and
  `portal.invoices.tsx` 368, both well inside the ceiling.

## What was built

| File | Change |
| --- | --- |
| `db/migrations/145_portal_payment_methods.sql` | *new* — the two columns, both defaulting `true`, with column comments. LF endings. |
| `src/integrations/supabase/database.types.ts` | Hand-added both columns to `companies` Row / Insert / Update. |
| `src/lib/paymentHandoff.ts` | *new* `enabledPaymentMethods` (KNET floor + fixed order) and `offeredPaymentMethods` (intersection with device). `paymentHandoffFor` and `isPaymentMethodOffered` untouched. |
| `src/lib/paymentHandoff.test.ts` | 13 → 24 tests, including the cross-product asserting KNET always survives on every device. |
| `src/components/portal/PayNowMenu.tsx` | Rewritten around three render states; method list replaced by a keyed presentation map. |
| `src/components/portal/PayNowMenu.test.tsx` | Updated for the new props; added the single-method disabled-state case (3 → 4 tests). |
| `src/components/portal/PayNowMenu.methods.test.tsx` | Rewritten: device filtering, admin settings, single-method collapse, loading state (5 → 11 tests). |
| `src/routes/portal.invoices.tsx` | Reads `useCompany`, derives the enabled/offered sets, passes both down, and tightens the `paySelected` guard. |
| `src/fns/createPayment.ts` | *new* exported `assertPortalMethodEnabled` and `enabledMethodsForTenant`; `TenantPaymentContext` carries `actingAsStaff`; guard wired before `reservePaymentRequest`. |
| `src/fns/createPayment.test.ts` | 27 → 33 tests; `createMockSupabase` gained a `companies` branch and a company-flags argument. |
| `src/components/admin/PortalPaymentMethodsCard.tsx` | *new* — two switches plus the KNET-always line. |
| `src/components/admin/PortalPaymentMethodsCard.test.tsx` | *new* — 3 tests, including "there is no KNET switch", checked in both switch configurations. |
| `src/routes/admin.settings.index.tsx` | Import, two schema fields, two defaults, two loads, one placement. |
| `src/i18n/dictionary.ts` | Four keys, both locales. |
| `src/components/portal/AnnouncementBanner.test.tsx` | Company fixture gained the two new columns. |

## Decisions taken during implementation

Three things changed from the original plan, each for a reason found while building:

1. **`text[]` → two booleans.** Making KNET a base rather than a list member
   removed the empty-list state entirely, and with it the CHECK constraint, the
   at-least-one form rule, the zero-state UI, and the Apple-Pay-only warning.
2. **`supabaseAdmin` → the caller's client** for the company read. Only the
   paying tenant reaches that code (staff are exempt), and
   `companies_select_tenant` already grants them the row — so bypassing RLS in a
   money path bought nothing. It still fails closed on every error branch.
3. **No `portal.invoices.noPaymentMethod` key.** Planned for the zero state,
   which no longer exists.

## Verification

- `bun run lint` — pass (24 pre-existing warnings, 0 errors).
- `bun run typecheck` — pass.
- `bun run test` — 221 files, 1870 tests, all passing on the branch as merged.
  On an earlier run from a different base, `src/lib/serverPdf.test.ts` timed out
  at 30s under full-suite parallelism and passed alone in 3s. That is a known
  load-dependent flake — it spawns real Chromium, and nothing in this change
  touches PDF rendering.
- `bun run format` — only the touched source files were formatted, to avoid the
  repo-wide markdown rewrite that would otherwise bury the real diff.

## Deploy

Migration 145 had to be applied **before** the merge, since a push to `main`
auto-deploys and new code against an old schema fails. Applied manually by the
user, then verified against `danatfuture-supabase-ozoxsa-db-1` on 2026-08-17:

- Both columns exist on `public.companies`, `is_nullable = NO`, `column_default
  = true`.
- The single company row reads `t | t` — so the deploy changes nothing for
  tenants until an admin turns a switch off.
- `notify pgrst, 'reload schema'` issued. Without it PostgREST keeps a stale
  signature cache and the new columns stay invisible to the API even though they
  exist in the table.
