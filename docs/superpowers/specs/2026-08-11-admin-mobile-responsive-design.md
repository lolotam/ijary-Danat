# Admin screens on a phone — design

**Date:** 2026-08-11
**Status:** approved, ready for implementation planning
**Scope:** `admin.inbox`, `admin.settings.notifications`,
`admin.settings.landing-page`, plus the admin header's touch targets.
**Supersedes** its own first draft on column hiding — see Decisions.
Presentation and file structure only — no data, no server function, no
migration, no new i18n keys.

Follows `2026-08-11-portal-mobile-responsive-design.md`, which named admin as a
deliberate second pass.

## Problem

Admin screens are built around real `<table>` elements, unlike the portal's
custom row `div`s. Nothing is *broken* on a phone — the shadcn `Table` primitive
already wraps every table in `overflow-auto` (`src/components/ui/table.tsx:11`),
so they scroll. They are simply unusable: too many columns, no indication the
content continues past the edge, and row controls below the touch minimum.

The audit corrected the assumption this pass started from. The inbox was flagged
as the worst offender at "32 columns", but that is 32 across **four** tables,
none wider than seven. The real problem is elsewhere:

| Screen | Widest table | Columns | File lines |
| --- | --- | --- | --- |
| `admin.settings.notifications` | notification log, L445 | **18** | 848 |
| `admin.settings.landing-page` | shops, L1124 | 12 | **1945** |
| `admin.inbox` | visitors L684 / leads L814 | 7 | 1249 |

Eighteen columns is roughly 2000px of table inside a 360px viewport.

Separately, all three files are two to four times the project's 500–600 line
ceiling. `CLAUDE.md` makes splitting a file you are already working in explicitly
in scope, so this pass cannot honestly ignore it.

## Decisions

Three decisions were taken before design, and the alternatives were rejected for
stated reasons rather than left implicit.

**1. One card rewrite, scroll everywhere else — because hiding a column here
hides data permanently.** The first draft of this spec tiered columns by
priority and hid the low tiers below a breakpoint. The audit killed that:
`admin.settings.notifications.tsx` and `admin.inbox.tsx` contain **zero**
dialogs or sheets, so there is no row-detail view anywhere. A hidden column is
not deprioritised on a phone, it is **unreachable on that device**. In the
notification log that would put `failure_reason` out of reach of an admin
diagnosing a failure from their phone — the exact field they opened the screen
for.

So the strategy is chosen per table by how much data hiding would cost:

- The **18-column notification log** gets a labelled card below `lg`, the
  pattern the portal already uses. All eighteen fields survive.
- **Every other table keeps all its columns** and scrolls, as it already does.
  Seven columns scroll acceptably, and the shops table's data is reachable
  through the seven dialogs that screen already has.

That is one card rewrite rather than the nine a blanket card policy would have
required, and no column becomes unreachable on any device.

**2. Split only what is touched.** Table sections that this pass modifies are
extracted into their own components. A full decomposition of all three files was
rejected as a speculative reorganisation of code this change never reads.

**3. Extraction lands before behaviour changes.** A pure code move and a
behaviour change in one diff cannot be reviewed — a reader cannot tell a moved
line from an edited one. Each file is extracted in one commit, then made
responsive in the next.

## Per-table strategy

### `admin.settings.notifications` — notification log (L445, 18 columns)

Two presentations of one row, from **one** field definition. The row's fields
become an array of `{ label, value }`; the table maps them to `<TableCell>`, the
card maps them to label/value pairs. Rendered as `hidden lg:table` and
`lg:hidden` respectively.

Deriving both from one array is the point. Writing the fields out twice would
guarantee they drift, and a card silently missing `failure_reason` is the defect
this whole redesign exists to avoid.

Both presentations sit in the DOM at once. That is acceptable here and should
not be "optimised": this deployment runs ~70 units, and the log is paginated —
the cost is a few hundred hidden nodes, against a correctness property worth far
more.

### Every other table

No column changes. They keep all columns and scroll inside the container the
shared `Table` primitive already provides
(`src/components/ui/table.tsx:11`). What they get is touch targets and, where
they are extracted, a smaller parent file.

- `admin.settings.notifications` templates (L650, 7 columns)
- `admin.settings.landing-page` shops (L1124, 12), slides (L1512, 7),
  gallery (L1693, 6)
- `admin.inbox` — four tables (L535, L684, L814, L1141), widest is 7

## The risk this design is built around

The notification log now renders its row twice. The failure mode is the two
presentations disagreeing — a field added to the table and forgotten in the
card, or a value formatted one way in one and differently in the other. That is
the same class of bug as a misaligned column, and just as quiet.

The mitigation is structural rather than procedural: **there is only one field
list**. If a field exists it appears in both, because both iterate the same
array. A reviewer's job is to confirm that property holds — that neither
presentation hardcodes a cell outside the loop — rather than to diff eighteen
fields by eye.

## Scroll affordance and touch targets

- No scroll affordance is added. The scroll container lives inside
  `src/components/ui/table.tsx`, which is shared with every screen in the app
  and is out of scope; wrapping each admin table in a second decorated container
  to avoid touching it would nest two scroll areas to solve a cosmetic problem.
  The native scrollbar remains the indication.
- Row action controls reach 44×44px on touch devices using the
  `pointer-coarse:` variant established in the portal pass. That variant is
  confirmed working — it compiles to a real `@media (pointer:coarse)` block, and
  Tailwind emits `padding-inline` for `px-*`, so it stays RTL-safe.
- **Admin header** (`admin.tsx:96-118`): the controls are inconsistent. The
  language button is `min-h-10` (40px), sign-out is `size="sm"` (36px), and
  `ThemeToggle` is now 44px on coarse pointers after the portal pass merged.
  Bring the other two to match. `ThemeToggle` itself is **not** touched — it was
  changed on `main` by that pass and needs no second edit.

## Out of scope

- **`src/components/ui/*`.** Shared with every screen; a change there is not an
  admin change. Row-level classes only.
- **`ThemeToggle.tsx`** — already handled on `main`.
- **The portal.** Done.
- **`admin.settings.landing-page`'s hardcoded bilingual strings.** That file
  writes `locale === "ar" ? "الهاتف" : "Phone"` inline instead of using `t()`
  (L1126-1137, L1514-1520, L1695-1700). It is a real inconsistency and it is
  **not** fixed here: converting it means adding ~25 dictionary keys in both
  locales, which is a separate change with its own review. Preserve the existing
  expressions exactly when moving them.
- Any table not listed above.

## Testing

Layout is not provable by unit test, and asserting on class strings would test
the implementation rather than the result. What applies:

- `bun run lint`, `bun run typecheck`, `bun run test` green. The extraction
  commits must not change any test.
- **One field list** in the notification log: confirm the table and the card
  both iterate the same array and neither hardcodes a cell outside it.
- **Field-count equality**: the rendered card and the rendered table row expose
  the same set of labels. Assertable in a unit test against the field-building
  function, which is pure — and that test is worth having, because it is the one
  invariant that keeps the two presentations honest.
- **Line counts** after extraction: report before and after for all three files.
- Manual verification at **360px**, **768px** and **1280px**, in **both** `ar`
  and `en`: no horizontal *page* scroll (tables scroll inside their own
  container), correct column sets per breakpoint, row actions reachable, RTL
  mirroring intact.
