# Tenant portal mobile responsiveness — design

**Date:** 2026-08-11
**Status:** approved, ready for implementation planning
**Scope:** the six tenant-portal screens and their components. Presentation
only — no data, no server function, no migration, no new i18n keys.

## Problem

Tenants use the portal on phones; admins use the app on desktops. The portal's
responsive *infrastructure* is already correct, but several screens have
specific layout defects on narrow viewports.

What is already right, and must not be "fixed" again:

| Concern | Where | State |
| --- | --- | --- |
| Viewport meta | `src/routes/__root.tsx:107` | `width=device-width, initial-scale=1, viewport-fit=cover` — correct |
| Notch / home-indicator insets | `portal.tsx:280`, `portal.invoices.tsx:297` | `env(safe-area-inset-*)` already applied |
| Horizontal table scroll | `src/components/ui/table.tsx:16` | every `Table` already wrapped in `overflow-auto` |
| Mobile sidebar | `src/components/ui/sidebar.tsx:190` | already swaps to a `Sheet` under 768px |
| Non-responsive grids | whole tree | only two bare `grid-cols-N` remain, both intentional |
| Contract switcher | `ContractSwitcher.tsx:57` | `w-full … sm:w-auto`, `min-h-11`, truncation, viewport-capped dropdown — use as the reference pattern |

So this is a gap fix against a named list, not a rewrite. An unbounded "make it
responsive" sweep would produce a diff nobody can review.

## The defects

### 1. Invoice rows stack into four full-width rows on phones

`src/routes/portal.invoices.tsx:228-282`

```
grid gap-4 bg-card p-4 … sm:grid-cols-[auto_auto_1fr_auto] sm:items-center
```

There is no mobile column count, so Tailwind's `grid` default of one column
applies below 640px and each of the four children becomes its own full-width
row: the number badge, then the checkbox, then the details block, then the
amount — separated by `gap-4`. An invoice list is unusably tall on a phone, and
the checkbox is stranded on a line of its own away from what it selects.

**Fix.** Below `sm`, put the number badge, the checkbox and the amount on one
header line with the details beneath it, so a phone row reads as a single card.
The `sm:` grid is correct and stays exactly as it is.

### 2. Payment rows stack into six rows, and crowd six columns at 640px

`src/routes/portal.payments.tsx:110`

```
grid gap-4 bg-card p-5 … sm:grid-cols-[1fr_1fr_1fr_1fr_auto_auto] sm:items-center
```

Same missing mobile column count as defect 1, one row worse — six stacked rows
per payment. Separately, six columns is too dense for the 640px `sm` breakpoint
where it currently activates; the reference, method, amount and date fields
collide on a small tablet.

**Fix.** A labelled two-column card below `sm`. Promote the six-column grid from
`sm:` to `lg:`, with an intermediate arrangement in between.

### 3. Header controls are below the touch-target minimum

`src/routes/portal.tsx:289-307`

The theme toggle, language button and sign-out button are `size="sm"` — roughly
32–36px tall against the 44×44px minimum. They sit in a single
`flex items-center justify-between gap-3` row alongside the brand logo and the
`AnnouncementBanner` marquee, and at 360px those five elements compete for
width.

**Fix.** Raise the controls to a 44px target on coarse pointers, and give the
logo / banner / controls group an explicit shrink order so the marquee yields
before the brand mark does.

### 4. Nav tabs are short and give no scroll affordance

`src/routes/portal.tsx:309-333`

The tab strip is `overflow-x-auto` — correct — but each tab is
`px-3 py-2 text-xs`, about 32px tall, again under the touch minimum. With up to
six tabs there is off-screen content and nothing indicating it scrolls.

**Fix.** 44px-tall tabs, and an edge fade or equivalent affordance so a tenant
can tell the strip continues.

### 5. Hero statistics go three-across at 640px

`src/routes/portal.index.tsx:71`

```
mt-8 grid gap-5 … pt-6 text-sm … sm:grid-cols-3
```

Three currency values across a 640px viewport, inside a card that already has
`p-6` padding — the longest Arabic label with a five-figure amount does not fit.

**Fix.** Step to `md:grid-cols-3`, matching the two grids below it on the same
page.

The other two grids on this page (`:33` and `:114`, both `md:grid-cols-3`) are
correct and are not touched.

### 6. Verify-only — no change expected

`src/routes/portal.lease.tsx:118` and `src/routes/portal.profile.tsx:116` both
use `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`, which is the correct ladder.
Confirm at 360px and leave them alone. Recording them here is deliberate: it
tells the implementer these were examined, not missed.

## Out of scope, and why

**Print and email templates.** `src/components/admin/InvoicePrint.tsx`,
`ReceiptPrint.tsx`, `src/lib/invoicePrintHtml.ts`,
`src/lib/paymentReceiptHtml.ts`, `src/lib/closeoutStatement.ts` and
`src/lib/emailTemplates.ts` all carry fixed widths **on purpose**. The PDF is an
html2canvas raster of that DOM, so a fluid width changes every generated
document; email clients need table layouts with fixed widths. Do not touch them.

**The public landing page.** `src/routes/index.tsx:385` uses
`max-w-[1440px] px-4 sm:px-6 lg:px-10 xl:px-14`, which is a page-shell cap with
a responsive gutter ladder — already correct, not a fixed width.

**Admin screens.** Agreed as a second pass. The targets there are
`admin.inbox.tsx` (32 table columns), `admin.settings.notifications.tsx` (28)
and `admin.settings.landing-page.tsx` (28).

## Constraints

- **RTL.** The portal runs Arabic-first with `dir="rtl"`. Every spacing or
  alignment change uses logical properties — `ps-*` / `pe-*` / `ms-*` / `me-*`,
  `start` / `end` — never `pl-*` / `pr-*` / `left` / `right`. The codebase
  already follows this; a regression here is invisible in an English screenshot.
- **No new strings.** These are layout changes. Any new copy would need both
  `ar` and `en` or `src/i18n/dictionary.test.ts` fails the suite — so if a fix
  seems to need copy, that is a signal the fix is wrong.
- **Dark mode.** Every touched row carries `dark:` variants already; preserve
  them.
- **File-size ceiling.** `portal.invoices.tsx` is 322 lines and
  `portal.payments.tsx` 212. If extracting a row component is the natural way to
  express the mobile layout, do it; do not let either file cross 500 lines.

## Testing

Layout is not provable by unit test, and writing assertions against class
strings would test the implementation rather than the result. The gates that
apply:

- `bun run lint`, `bun run typecheck`, `bun run test` must pass — existing portal
  tests (`PayNowMenu.test.tsx`, `ContractSwitcher.test.tsx`,
  `AnnouncementBanner.test.tsx`) must not regress.
- Manual verification on the dev server at **360px** (small Android), **390px**
  (iPhone), **414px** and **768px**, in **both** `ar` and `en`, checking:
  - no horizontal page scroll at any width,
  - every interactive control at least 44×44px,
  - the sticky pay bar on `/portal/invoices` does not cover the last row,
  - RTL mirroring intact.

## Relationship to the Apple Pay spec

Apple Pay handoff behaviour is a separate spec,
`2026-08-11-applepay-device-handoff-design.md`. The two touch
`portal.invoices.tsx` and `PayNowMenu.tsx` in common, so the Apple Pay change
lands first and this one rebases onto it.
