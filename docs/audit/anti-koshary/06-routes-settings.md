# S06 — `src/routes`: `admin.settings.*`

**Lines read:** ~5,720 · **Files:** 10 · **Date:** 2026-09-22

`admin.settings.users.tsx` (1421) · `admin.settings.landing-page.tsx` (1252) ·
`admin.settings.lists.tsx` (784) · `admin.settings.index.tsx` (671) ·
`admin.settings.notifications.tsx` (651) · `admin.settings.roles.tsx` (625) ·
`admin.settings.integrations.tsx` (180) · `admin.settings.cards.tsx` (79) ·
`admin.settings.backup.tsx` (52) · `admin.settings.cron.tsx` (8).

**Overall:** the two largest files in `src/routes` are here, and so is the repo's largest
single component (1,052 lines). But the finding that matters most is not size — it is that
this directory hosts a **second, unguarded translation system** running alongside the one
with the test.

---

## Findings

### 1 · High — 306 inline bilingual strings bypass the i18n dictionary and its enforcement test

**Where:** `locale === "ar" ? "…" : "…"` appears **306 times** across `src/`, non-test.
Concentrated:

| File | Count |
| --- | --- |
| `routes/admin.settings.landing-page.tsx` | **57** |
| `routes/index.tsx` (the public landing page) | **53** |
| `routes/admin.settings.roles.tsx` | **32** |
| `components/admin/landing-page/ShopsTable.tsx` | 19 |
| `components/admin/ownedPageKpis.tsx` | 18 |
| `components/shared/dashboardCards.tsx` | 13 |
| `components/admin/landing-page/AdminBrandDialog.tsx` | 13 |
| `routes/admin.index.tsx` | 9 |
| `lib/invoicePrintHtml.ts` · `lib/closeoutStatement.ts` | 9 · 7 |
| …10 more files | 1–7 each |

`src/i18n/dictionary.ts` holds ~2,088 keys per locale, and `src/i18n/dictionary.test.ts`
guards it hard — it asserts (a) `ar` and `en` define **exactly** the same keys, (b) every
`t("literal")` in every source file resolves, and (c) every interpolated key family exists.
Its docblock says why it was written:

> *"six broken labels [shipped] in Batches C–F… the Add button on three screens read
> `common.add`. `bun run lint`, `typecheck` and the whole unit suite stayed green."*

**Which means:** 306 user-facing strings sit outside every one of those three checks. They
cannot be found by a translator, they are invisible to the parity test that exists precisely
to catch a missing translation, and they encode the *set of supported locales* in 306
separate ternaries — so adding a third language is a 306-site edit rather than one new
dictionary object. `routes/index.tsx` alone, the **public marketing page**, carries 53 of
them, and `lib/invoicePrintHtml.ts` and `lib/closeoutStatement.ts` carry 16 more into
printed documents a tenant receives.

There is a second, quieter cost: the ternary form silently defeats the fallback. `t()` falls
back to the raw key and renders visibly wrong; `locale === "ar" ? a : b` renders the English
branch for *any* non-`"ar"` locale, including one that does not exist yet, with no signal.

**Fix:** move them into `dictionary.ts` — mechanical, and the test will immediately start
covering them. Do it per-file, biggest first; `admin.settings.landing-page.tsx` (57) and
`routes/index.tsx` (53) are a third of the total between them. **Do not** attempt all 306 in
one commit.

---

### 2 · Medium — the repo's largest single component: 1,052 lines

**Where:** `src/routes/admin.settings.landing-page.tsx:105-1157` (`AdminLandingPageSettings`)

One function body holding: an Arabic/English edit-language switch, **5** queries
(`useLandingSettings` ×2, sections, slides, media), **9** mutations, a `react-hook-form`
instance for slides, 16 `useState`, two separate permission models (landing *tables* are
`is_staff`, the landing *bucket* is `has_role(admin)` — correctly distinguished at
`:109-113`), a slide dialog, a media dialog, a gallery manager, and a section-toggle editor.

`CompanyContactForm` is the only thing extracted (`:1158`).

**Which means:** this file churns 35×/year — the third-highest in the repo — and is 2× the
ceiling `CLAUDE.md` sets on the grounds that *"a file that fits in one context window is one
an agent can reason about correctly and edit reliably."* It does not fit. A memory note from
an earlier session records that the admin forms here needed `key={editLang}` to remount
correctly, which is exactly the class of bug a 1,052-line component with a language switch
at the top produces.

**Fix:** the sections are already visually separate. Extract `SlidesPanel`, `GalleryPanel`,
`SectionsPanel` and `LandingTextForm` into `components/admin/landing-page/` (which already
exists and holds `ShopsTable`, `AdminBrandDialog`). Each takes `editLang` as a prop. Finding
1's 57 strings are in this file, so do finding 1 during the split rather than twice.

---

### 3 · Medium — the largest file in `src/routes`: 1,421 lines, 31 `useState`

**Where:** `src/routes/admin.settings.users.tsx` — `UsersPage` (:99-480), `UsersTable`
(:481), `GrantRoleDialog` (:693), `RevokeRoleDialog` (:781), `CreateUserDialog` (:839),
`EditUserDialog` (:1143)

Better structured than finding 2 — six components rather than one — but they share a file
that is 2.4× the ceiling, and 31 pieces of state across them. This is also the file where
**H5** lives (the screen gates Create/Edit/Delete on `users.*` permissions the server
ignores), which is not a coincidence: the authorization decision is spread across four
components in one file and nothing made the inconsistency visible.

**Which means:** 36 changes in 12 months to a file no reviewer reads end to end. The
dialogs are self-contained and the split is low-risk.

**Fix:** move the four dialogs to `components/admin/users/`. Leave `UsersPage` and
`UsersTable`. Roughly 700 lines out of the file, no behaviour change.

---

### 4 · Medium — ~850 lines of UI and hook for a feature that has no storage in production

**Where:** `src/routes/admin.settings.roles.tsx` (625) + `src/hooks/useCustomRoles.ts` (~230)
· `db/migrations/16_custom_roles.sql`

`useCustomRoles.ts:19-21`:

```ts
const table      = supabase.from("custom_roles" as never) as never;
const permsTable = supabase.from("custom_role_permissions" as never) as never;
const rolePermsTable = supabase.from("role_permissions") as never;
```

and `:23-31`, in the code's own words:

> *"PostgREST answers `PGRST205` for a table its schema cache does not know… on this
> deployment they are simply the truth: **migration 16 was never applied**, so the feature
> has no storage behind it."*

`custom_roles` appears **zero** times in `database.types.ts`, so all eleven query call sites
are cast through `as never` / `as any` and **nothing in this hook typechecks**.

**Which means:** a settings screen, a sidebar entry and a third authorization model
(`has_role` · `has_permission` · custom roles) exist for a feature that cannot store
anything. The handling is genuinely careful — `null` is kept distinct from `[]` so the
screen refuses to offer a save that would fail, and the comment records that *"production
spent months showing an editor whose every save was going to fail."* But careful handling of
a permanently-absent backend is still 850 lines of maintenance surface, and it is the only
reason those eleven `any` casts exist.

**Decision required, and it is a business one — flagged, not chosen:**
apply migration 16 (then hand-copy the two tables into `database.types.ts` and delete the
casts), or delete the feature. The current state is the only one with no upside.

---

## Not reported, and why

- **`src/lib/permissions.ts` as the single permission catalogue** — one `PERMISSIONS`
  object, no second copy anywhere. Correct.
- **`admin.settings.index.tsx` at 671 lines across 11 components** — over the file ceiling
  but genuinely decomposed; average component ~60 lines. Not the same problem as findings
  2 and 3.
- **`admin.settings.cron.tsx` (8 lines), `.backup.tsx` (52), `.cards.tsx` (79)** — thin
  route shells over components. This is the pattern the other settings routes should reach.
- **The landing-page dual permission model** (`is_staff` for tables, `has_role(admin)` for
  the bucket, with a hint string explaining the difference to the user at
  `:109-113`) — deliberate, documented, and the UX handles it. Not a finding.

## Test coverage of this scope

No route-level tests for any of the ten files. The i18n **dictionary** is well tested
(`dictionary.test.ts`), which is exactly why finding 1 matters: the guard exists and 306
strings are outside it. `useCustomRoles` has no test and could not meaningfully have one —
its tables do not exist.

**Consequence for Pass 2:** finding 1 is mechanical and the dictionary test will *verify* it
as you go — every string moved into the dictionary immediately gains parity checking, so the
suite gets stronger with each commit. That makes it the safest large change in this audit.
Findings 2 and 3 are uncovered refactors: small commits, manual check per panel. Finding 4 is
a decision, not a change.

## Ledger entries added

See `LEDGER.md` — the inline bilingual ternary, the oversized settings components, the
custom-roles feature, the permission catalogue (recorded as correct).
