# Admin mobile responsiveness — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three worst admin screens usable on a phone without making any data unreachable, and bring the three oversized files back toward the project's line ceiling.

**Architecture:** The 18-column notification log gains a second presentation — a labelled card below `lg` — driven from the *same* column list that builds the table, so the two cannot disagree. Every other table keeps all its columns and scrolls as it already does. Table sections that get touched are first extracted into components in a pure-move commit, then modified in a following commit.

**Tech Stack:** TanStack Start (React 19), TypeScript, Tailwind CSS 4.2.4, shadcn/ui (Radix), Vitest, Bun.

Spec: `docs/superpowers/specs/2026-08-11-admin-mobile-responsive-design.md`.

## Global Constraints

- **Branch:** `feat/admin-mobile-responsive`, off `main` after PR #116 merged. Never commit to `main`. Never force-push, rebase, amend or squash.
- **Arabic doc comments** above every function created or modified, leading with an Arabic sentence. English only for the *why*.
- **Logical properties only** — `ps-*`/`pe-*`/`ms-*`/`me-*`/`start`/`end`. Never `pl-*`/`pr-*`/`left`/`right`. Admin renders `dir="rtl"` in Arabic.
- **No new i18n keys.** `src/i18n/dictionary.test.ts` fails on a key present in only one locale.
- **Do not touch `src/components/ui/*`** — shared with every screen.
- **Do not touch `src/components/ThemeToggle.tsx`** — already changed on `main` by the portal pass.
- **Preserve `dark:` variants** and every existing `className` when moving code.
- **`admin.settings.landing-page.tsx` uses inline `locale === "ar" ? "…" : "…"` instead of `t()`.** Preserve those expressions **exactly** when moving them. Converting them to dictionary keys is explicitly out of scope.
- **Extraction commits are pure moves.** No renames, no reordering, no "while I'm here" cleanups, no behaviour change. That is what makes them reviewable.
- **Gates before any commit:** `bun run lint`, `bun run typecheck`, `bun run test`, `bun run format`.
- **After `bun run format`, revert markdown churn** before staging: `git checkout -- AGENTS.md CLAUDE.md docs/`. Prettier rewrites every tracked `.md` and buries the real diff.

## Amendments after the Codex design review

**These override the task text below wherever they conflict. Read them first.**

**A1 — Branch baseline (was wrong).** The plan claimed `main` already carried the
portal pass. It did not: this branch was cut from `main` *before* PR #116 merged,
so `ThemeToggle` was still 40px here. `origin/main` has since been merged in, and
`ThemeToggle` now carries `pointer-coarse:size-11`. It stays untouched.

**A2 — Follow the mobile-card pattern admin already has.** `admin.invoices.tsx:786`
renders `isMobile ? <cards> : <table>` using `useIsMobile()` from
`src/hooks/use-mobile.tsx`. The notification log uses **that same pattern**, not
the `hidden lg:table` / `lg:hidden` CSS pair this plan originally specified.

Two reasons, both decisive. It renders **one** presentation instead of putting
both in the DOM, which removes the duplicate-node cost entirely. And a second
responsive mechanism in the same app is a pattern a future reader has to notice
and choose between — the codebase already made this choice.

Consequence: the `lg` versus container-query argument is moot. `useIsMobile()` is
767px, and below that the sidebar is a `Sheet`, so content width *is* viewport
width and the sidebar arithmetic does not apply. Between 768px and desktop the
table scrolls exactly as it does today — not a regression, since it scrolls at
every width today.

**A3 — One descriptor array, carrying render and title.** Not the
`notificationLogColumns()` + `notificationLogValues()` pair below. A single typed
array of `{ key, label, render(item), cellClassName?, title?(item) }`.

`title` is load-bearing and the original plan would have dropped it: cells like
recipient, sender, provider ID and failure are `max-w-36 truncate`, so the full
value is reachable **only** through the tooltip
(`admin.settings.notifications.tsx:519`, `:551`, `:565`). Losing it would
reintroduce exactly the unreachable-data defect this design exists to prevent.

**A4 — Keep the inbox queries in the route.** Codex proposed extracting whole tab
features that own their query and state, to avoid an 18-prop component. The
concern is right; that remedy is not. The tab triggers render unread-count badges
from those queries (`admin.inbox.tsx:479-500`), and Radix unmounts inactive
`TabsContent` — so moving the queries into tab bodies would stop them running for
inactive tabs and blank the badges.

Instead: queries and derived counts stay in the route, and props are grouped into
cohesive objects rather than eighteen flat ones —
`selection={{ ids, toggle, toggleAll, allSelected }}`,
`pagination={{ page, setPage, pageSize }}`, `sorting={{ sort, setSort }}`, plus
`rows` and the row-action handlers. Four to six props, each a named concept.

**A5 — Mobile select-all.** The card view needs the desktop select-all
(`admin.settings.notifications.tsx:447`), or bulk delete becomes unusable on a
phone. Add a selection line above the cards: select-all, selected count, clear.
Reuse existing keys only — a new label needs both locales.

**A6 — Scroll affordance is back in scope.** The original rationale was factually
wrong. Notifications already has its own local scroll wrapper
(`admin.settings.notifications.tsx:443`) and shops has `overflow-x-auto` outside
the shared primitive (`admin.settings.landing-page.tsx:1122`). A non-interactive
inline-end fade on those existing local wrappers needs no change to
`src/components/ui/table.tsx` and creates no second scroll container.

**A7 — Wider touch-target inventory.** Beyond `size="icon"` row actions: the
`SidebarTrigger` is `h-7 w-7` but accepts `className` (fix at the call site in
`admin.tsx`); `InboxBell` is 40px and is admin-specific, so fix it directly
(`src/components/admin/InboxBell.tsx:109`); the lead status trigger is 32px
(`admin.inbox.tsx:888`); inbox `size="sm"` row actions (`:612`, `:622`, `:1210`)
and the Gmail delete icon (`:1231`); shop website and Instagram links are ~16px
targets (`admin.settings.landing-page.tsx:1211`, `:1224`).

Still **out of scope**: `ui/checkbox.tsx`, `ui/tabs.tsx`, `ui/button.tsx` — shared
with every screen. Where a primitive is too small and takes no `className`, say so
in the report rather than plumbing a prop through a shared component.

**A8 — Honesty about the line ceiling.** After extracting one table each, the
routes land at roughly 840 (inbox), 680 (notifications) and 1770 (landing page).
**None reaches 500–600.** Report the real numbers and record the remainder as
follow-up; do not imply the ceiling was met.

**A9 — Out of scope, recorded rather than silently skipped.** `admin.contracts.tsx`
is 1492 lines with 14–16 columns — worse than the shops table this pass does fix,
and named in `CLAUDE.md:45` as a known offender. It is not in this pass because
the pass was scoped to three named screens. It is the next one.
`admin.invoices.tsx` already renders mobile cards, so it is a file-size problem
rather than a layout one.

**A10 — Workflow corrections.** `bun run format` runs before **every** commit,
including the extraction commits. Guard skills run before committing, not only at
the end. Revert formatter churn with **named files only** — never a blanket
`git checkout -- docs/`, which would discard unrelated working changes. Run
`graphify update .` after the code changes (`AGENTS.md:90`). Add Arabic-first doc
comments to `AdminLayout`, `NotificationsPage` and `AdminLandingPageSettings`,
which this pass modifies and which currently lack them.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/components/admin/inbox/TenantMessagesTable.tsx` *(create)* | Inbox "tenants" tab table |
| `src/components/admin/inbox/VisitorMessagesTable.tsx` *(create)* | Inbox "visitors" tab table |
| `src/components/admin/inbox/LeadsTable.tsx` *(create)* | Inbox "leads" tab table |
| `src/components/admin/notifications/notificationLogColumns.tsx` *(create)* | The single column list + per-row values. The one source both presentations read. |
| `src/components/admin/notifications/notificationLogColumns.test.tsx` *(create)* | Pins that the two presentations cannot diverge |
| `src/components/admin/notifications/NotificationLogTable.tsx` *(create)* | Table above `lg`, cards below |
| `src/components/admin/landing-page/ShopsTable.tsx` *(create)* | Landing-page shops tab table |
| `src/routes/admin.inbox.tsx` *(modify)* | Loses three tables |
| `src/routes/admin.settings.notifications.tsx` *(modify)* | Loses the log table |
| `src/routes/admin.settings.landing-page.tsx` *(modify)* | Loses the shops table |
| `src/routes/admin.tsx` *(modify)* | Header touch targets |

---

## Task 1: Extract the inbox tab tables — pure move

**Files:**
- Create: `src/components/admin/inbox/TenantMessagesTable.tsx`, `VisitorMessagesTable.tsx`, `LeadsTable.tsx`
- Modify: `src/routes/admin.inbox.tsx` — the `TabsContent` blocks at L511-658 (tenants), L659-788 (visitors), L789-927 (leads)

The Gmail tab (L928+) is **not** extracted: it has its own nested tabs and this pass does not modify it.

**Interfaces:**
- Produces: three components. Each takes exactly the values its block reads from the parent scope — no more. Derive the prop list mechanically: every identifier the moved JSX references that is defined outside it becomes a prop. Do not pass the whole parent state object "for convenience"; that recreates the coupling the extraction exists to remove.

- [ ] **Step 1: Record the starting line count**

Run: `wc -l src/routes/admin.inbox.tsx`
Expected: 1249. Write the number down; Step 5 compares against it.

- [ ] **Step 2: Move the three blocks**

For each of the three `TabsContent` blocks, move the JSX **verbatim** into its component and render `<TenantMessagesTable … />` etc. in its place. Keep the `<TabsContent value="…" className="mt-4">` wrapper in the route; move only its children.

Every `className`, `key`, `title`, `aria-label`, animation `style` and comment moves unchanged. Any change beyond adding the function signature and its imports is a defect in this task.

- [ ] **Step 3: Add an Arabic doc comment to each new component**

```tsx
/**
 * جدول رسائل المستأجرين في صندوق الوارد.
 *
 * Extracted from admin.inbox.tsx, which was 1249 lines. Behaviour is unchanged.
 */
```

- [ ] **Step 4: Prove the move changed nothing**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green, and **no test file modified**. If a test needed changing, the move was not pure — revert and redo it.

- [ ] **Step 5: Report the line counts**

Run: `wc -l src/routes/admin.inbox.tsx src/components/admin/inbox/*.tsx`
Report before and after. The route should drop substantially; state the number rather than claiming "smaller".

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.inbox.tsx src/components/admin/inbox/
git commit -m "refactor(admin): extract the inbox tab tables into components"
```

---

## Task 2: Extract the notification log — pure move

**Files:**
- Create: `src/components/admin/notifications/NotificationLogTable.tsx`
- Modify: `src/routes/admin.settings.notifications.tsx` — the log table inside `TabsContent value="pool"` (L267-622), specifically the `<Table>` at L443-620

**Interfaces:**
- Produces: `NotificationLogTable`, taking the notification page data, `page`, `canDelete`, `selected`, `setSelected`, and the retry/cancel handlers. Exact prop list is whatever the moved JSX references — derive it mechanically as in Task 1.

Move the `<Table>` and its scroll wrapper (`max-h-[min(70vh,52rem)] overflow-auto` at L443). Leave the tab's filters, pagination and bulk-action bar in the route — this task moves the table only.

- [ ] **Step 1: Record the line count**

Run: `wc -l src/routes/admin.settings.notifications.tsx` — expected 848.

- [ ] **Step 2: Move the table verbatim, add the Arabic doc comment, then prove it changed nothing**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green, no test file modified.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin.settings.notifications.tsx src/components/admin/notifications/
git commit -m "refactor(admin): extract the notification log table"
```

---

## Task 3: Extract the landing-page shops table — pure move

**Files:**
- Create: `src/components/admin/landing-page/ShopsTable.tsx`
- Modify: `src/routes/admin.settings.landing-page.tsx` — the shops `<Table>` at L1122-1300 inside `TabsContent value="brands"`

Slides (L1512) and gallery (L1693) are **not** extracted: this pass does not modify them beyond touch targets in Task 5, and extracting them would be a speculative reorganisation.

**Remember:** this file writes `locale === "ar" ? "الهاتف" : "Phone"` inline. Move those expressions **character-for-character**. Do not "improve" them into `t()` calls — that needs ~25 new dictionary keys in both locales and is a separate change.

- [ ] **Step 1: Record the line count**

Run: `wc -l src/routes/admin.settings.landing-page.tsx` — expected 1945.

- [ ] **Step 2: Move the table verbatim, add the Arabic doc comment, prove it changed nothing**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green, no test file modified.

- [ ] **Step 3: Commit**

```bash
git add src/routes/admin.settings.landing-page.tsx src/components/admin/landing-page/
git commit -m "refactor(admin): extract the landing-page shops table"
```

---

## Task 4: One column list, two presentations, for the notification log

**Files:**
- Create: `src/components/admin/notifications/notificationLogColumns.tsx`
- Create: `src/components/admin/notifications/notificationLogColumns.test.tsx`
- Modify: `src/components/admin/notifications/NotificationLogTable.tsx` (from Task 2)

This is the task the whole plan exists for. Eighteen columns cannot fit a phone, and hiding them is not an option — there is no row-detail view anywhere on this screen, so a hidden column is **unreachable**, and `failure_reason` is exactly what an admin opens this log to read.

So the row renders twice: a `<TableRow>` above `lg`, a labelled card below. Both iterate **one** column list. Writing the fields out twice would guarantee they drift, and a card silently missing a field is the defect this design exists to prevent.

**Why `lg:` and not a container query.** The admin layout has a collapsible
sidebar (~16rem), so content width is not viewport width — which is the textbook
case for `@container`, and Tailwind 4 supports it. It is deliberately *not* used
here for two reasons: this codebase resolves every breakpoint against the
viewport, and introducing container queries in one component makes a second
pattern a future reader has to notice; and the practical difference is one
breakpoint step — at `lg` with the sidebar open, content is ~768px, where the
table already scrolls acceptably. If admin later adopts container queries
broadly, this component should move with it rather than lead it.

**Three cells sit outside the loop, by design:** the conditional `canDelete` checkbox, the row number, and the actions cell. They are structural rather than data, and both presentations must render all three. Everything else goes through the list.

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/notifications/notificationLogColumns.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import {
  notificationLogColumns,
  notificationLogValues,
} from "./notificationLogColumns";

/** ترجمة وهمية تعيد المفتاح نفسه. */
const t = (key: string) => key;

/** صف سجل إشعارات بأقل الحقول المطلوبة. */
const ROW = {
  id: "n1",
  audience: "tenant",
  channel: "email",
  failure_reason: "SMTP timeout",
  status: "failed",
  tenant: { name: "Tenant A", reminders_enabled: true },
} as const;

describe("the notification log's two presentations cannot diverge", () => {
  it("produces a value for every declared column", () => {
    // The invariant that makes the card safe. A column with no value renders an
    // empty cell on desktop and a stray label on mobile; a value with no column
    // is data that exists in the row and is shown nowhere.
    const columnKeys = notificationLogColumns(t).map((column) => column.key);
    const valueKeys = Object.keys(notificationLogValues(ROW as never, t));
    expect([...valueKeys].sort()).toEqual([...columnKeys].sort());
  });

  it("gives every column a non-empty label", () => {
    // The card shows labels the table puts in its header. A blank one is
    // invisible on desktop and a mystery value on mobile.
    for (const column of notificationLogColumns(t)) {
      expect(column.label.trim()).not.toBe("");
    }
  });

  it("keeps failure_reason among the columns", () => {
    // Named explicitly: this is the field whose unreachability on mobile caused
    // the card design in the first place.
    expect(notificationLogColumns(t).map((c) => c.key)).toContain("failure");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test -- src/components/admin/notifications/notificationLogColumns.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create the column list**

`notificationLogColumns.tsx` exports two functions:

```tsx
/**
 * أعمدة سجل الإشعارات: المفتاح والعنوان، بالترتيب المعروض.
 *
 * The single source both presentations read. The table maps it to header cells,
 * the mobile card to labels. Two hand-written lists would drift, and a card
 * missing `failure` is exactly the defect this file prevents.
 */
export function notificationLogColumns(t: (key: string) => string): NotificationLogColumn[]

/**
 * قيم صف واحد، مفهرسة بمفتاح العمود.
 *
 * Returns a ReactNode per key so the existing badges, truncation and monospace
 * formatting survive. Keys must match `notificationLogColumns` exactly — pinned
 * by the test.
 */
export function notificationLogValues(item: NotificationLogItem, t: …): Record<string, ReactNode>
```

Build both by lifting the existing `<TableHead>` labels (L460-477) and `<TableCell>` bodies (from L488 onward) out of `NotificationLogTable`. Carry each cell's existing `className` on the column entry as `cellClassName` so the table keeps `max-w-36 truncate font-mono text-xs` and friends; the card ignores it.

The sixteen data columns, in order: `tenant`, `audience`, `to`, `from`, `type`, `related`, `language`, `channel`, `template`, `scheduledAt`, `sentAt`, `provider`, `providerId`, `status`, `failure`, `retries`.

- [ ] **Step 4: Run the test until it passes**

Run: `bun run test -- src/components/admin/notifications/notificationLogColumns.test.tsx`
Expected: PASS.

- [ ] **Step 5: Render both presentations**

In `NotificationLogTable.tsx`:

- The `<Table>` gains `hidden lg:table` on the element itself, and header/body cells come from the column list.
- Below it, a `lg:hidden` list of cards. One card per row: the row number and the checkbox in a header line, then a `<dl>` of label/value pairs from the same list, then the actions.
- Skip a card row whose value is `"—"` only if you also skip it in the table. Simpler and safer: render every field in both.

- [ ] **Step 6: Verify no field was lost**

Run this and confirm the two counts match:

```bash
grep -c "column.key\|col.key" src/components/admin/notifications/NotificationLogTable.tsx
```

Then read the file and confirm **no `<TableCell>` or card row hardcodes a data field outside the loop** — only the checkbox, row number and actions may sit outside it.

- [ ] **Step 7: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git checkout -- AGENTS.md CLAUDE.md docs/
git add src/components/admin/notifications/
git commit -m "feat(admin): show the notification log as cards on a phone"
```

---

## Task 5: Touch targets across admin

**Files:**
- Modify: `src/routes/admin.tsx` — the header controls at L96-118
- Modify: the extracted table components from Tasks 1–3, plus `src/routes/admin.settings.notifications.tsx` (templates table) and `src/routes/admin.settings.landing-page.tsx` (slides, gallery)

Row action buttons are `size="icon"`, which is `size-10` — 40px, under the 44px minimum (`src/components/ui/button.tsx:27`).

- [ ] **Step 1: Fix the admin header's inconsistency**

`ThemeToggle` is already 44px on coarse pointers after the portal pass; its two neighbours are not, so the row is visibly uneven on a touch device.

- Language button (L100-105): add `pointer-coarse:min-h-11 pointer-coarse:min-w-11` to its `className`.
- Sign-out `Button` (L110-118): add `className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"`.
- `SidebarTrigger` (L93) and `InboxBell` (L97): check their rendered size; add the same classes if either is under 44px and accepts a `className`. If one does not accept `className`, **leave it and say so** — do not add prop plumbing to a shared component.
- Do **not** touch `ThemeToggle`.

- [ ] **Step 2: Enlarge row action buttons**

For every `size="icon"` button inside the admin tables listed above, add `pointer-coarse:size-11`. Leave `size="icon"` in place — the variant supplies the base 40px and the media query overrides it, which is how the portal pass did it.

- [ ] **Step 3: Verify the variant reached the CSS**

An unrecognised Tailwind variant emits no CSS and no error, so this must be checked rather than assumed:

```bash
bun run build
grep -o "pointer-coarse\\\\:size-11" .output/public/assets/*.css | head -1
```

Expected: a match. If empty, the class did not compile — report it rather than proceeding.

- [ ] **Step 4: Gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run format
git checkout -- AGENTS.md CLAUDE.md docs/
git add src/routes/admin.tsx src/routes/admin.settings.notifications.tsx src/routes/admin.settings.landing-page.tsx src/components/admin/
git commit -m "fix(admin): give header and table row controls a 44px touch target"
```

---

## Task 6: Verification

- [ ] **Step 1: Line counts, before and after**

```bash
wc -l src/routes/admin.inbox.tsx src/routes/admin.settings.notifications.tsx src/routes/admin.settings.landing-page.tsx
```

Report against the starting 1249 / 848 / 1945. Landing-page will still exceed the ceiling — say so plainly rather than implying the ceiling was met.

- [ ] **Step 2: Confirm the extractions were pure**

```bash
git diff main --stat -- src/routes/admin.inbox.tsx
```

The route files should show far more deletions than insertions. A large insertion count in a route means logic was rewritten rather than moved.

- [ ] **Step 3: Manual sweep**

`/admin/inbox`, `/admin/settings/notifications`, `/admin/settings/landing-page` at **360px**, **768px** and **1280px**, in **both** `ar` and `en`:

- no horizontal **page** scroll — tables scroll inside their own container;
- the notification log shows cards below `lg` and the full table at `lg`, with every field present in both;
- row actions reachable and at least 44px under a coarse pointer;
- RTL mirroring intact.

Record which combinations were actually opened. Do not claim a check that was not run.

- [ ] **Step 4: Full gates**

```bash
bun run lint && bun run typecheck && bun run test
```

Paste real output. Note that `src/lib/serverPdf.test.ts` is a **known pre-existing flake** — it launches Chromium and fails roughly one run in three. It is unrelated to this branch; if it fails, re-run and say so rather than investigating it as a regression.

## Definition of done

- [ ] `lint` 0 errors, `typecheck` exit 0, `test` green (modulo the serverPdf flake).
- [ ] The extraction commits changed no test file.
- [ ] `notificationLogColumns.test.tsx` passes, and was seen to fail before the module existed.
- [ ] No data field is reachable on desktop but not on mobile.
- [ ] No new i18n keys; `dictionary.test.ts` passes.
- [ ] Every function created or modified carries an Arabic-first doc comment.
- [ ] No `pl-*`/`pr-*`/`ml-*`/`mr-*` introduced.
- [ ] `src/components/ui/*` and `ThemeToggle.tsx` untouched.
- [ ] Landing-page's inline `locale === "ar" ? …` expressions are byte-identical to before.
- [ ] `clean-code-guard` on the production diff, `test-guard` on the test diff, `docs-guard` on doc comments.
