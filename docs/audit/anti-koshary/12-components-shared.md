# S12 — `src/components`: ui, portal, landing, shop, shared, root

**Lines read:** ~6,620 · **Files:** 71 · **Date:** 2026-09-22

`ui/` (52 files, 4872) · `portal/` (9 files, 1107) · `shared/` (2 files, 235) ·
`landing/` (3 files, 120) · `shop/` (1 file, 96) · root (4 files, 164).

**Overall: nothing to fix here.** Outside the vendored shadcn layer, the largest file in this
entire scope is 276 lines. This is the section of the audit where the right answer is a short
one, and padding it would cost the real findings their attention.

---

## Findings

None that meet the bar. Two observations recorded because they change what Pass 2 should do
elsewhere:

### A · `components/landing/` is nearly empty — which is where S07 #1's 1,400 lines belong

`src/components/landing/` holds **3 files and 120 lines** (`CarouselDots` 69, `TypedText` 40,
one more) while `src/routes/index.tsx` holds a 1,922-line component containing twelve page
sections. The destination directory for S07 #1's extraction already exists, is already
conventionally named, and is almost unused. That is not a finding in this scope; it is the
confirmation that S07 #1's proposed fix follows the repo's own structure rather than
inventing one.

### B · `ui/` is vendored shadcn and should be left alone

52 files. `sidebar.tsx` (750), `chart.tsx` (331), `carousel.tsx` (247) and `menubar.tsx` (229)
are upstream shadcn blocks shipped at their published size — they breach the repo's 500-line
ceiling only in the sense that vendored code does, and rewriting them would mean maintaining
a fork. Five files carry local Arabic-commented modifications (`empty-state.tsx`,
`label.tsx`, `linkified-text.tsx`, `password-input.tsx`, `table.tsx`) and those are
deliberate, documented app-specific additions.

**Pass 2 must not touch `src/components/ui/`** except for a specific, named bug.

---

## Not reported, and why

- **`portal/` (9 files, avg 123 lines)** — `PaymentRowActions` (276), `ShopDetailsPanel`
  (151), `ApplePayQrDialog` (142), `PayNowMenu` (124) and five smaller. Correctly sized, one
  job each, no direct data access. The tenant-facing surface is the tidiest in the app.
- **`shared/dashboardCards.tsx` (185)** — carries 13 of S06 #1's inline bilingual ternaries,
  counted there. The component itself is fine.
- **`LtrText`** — 149 usages across the tree. A memory note from an earlier session flagged
  `LtrText` pairs as a possible written-but-never-read shape; **that is not the case here** —
  it is genuinely used at 149 sites to force LTR rendering of codes and numbers inside RTL
  text, which is exactly what an Arabic-primary UI needs. Recorded so the old note is not
  acted on.
- **Root components** (`BrandLogo` 47, `ThemeProvider` 67, `ThemeToggle` 40, `SkipLink` 10) —
  all tested, all minimal.

## Test coverage of this scope

The best-covered scope in the audit: `ui/` ships test files alongside most components
(`table.test.tsx`, `button`, `form`, …), and `BrandLogo`, `SkipLink` and several portal
components have their own. One known weakness carried over from an earlier session:
`buttonVariants` bakes `disabled:*` classes into every render, so a test asserting
`toMatch(/disabled/)` passes vacuously — assert `disabled=""` instead. That is a
**test-quality** note for whoever next edits those specs, not a finding against this code.

**Consequence for Pass 2:** no work is planned in this scope. If a change here becomes
necessary as a side effect of S07 #1, keep it to imports.

## Ledger entries added

See `LEDGER.md` — `components/landing/` as the S07 #1 destination; `ui/` as vendored and
off-limits; `LtrText` recorded as genuinely used.
