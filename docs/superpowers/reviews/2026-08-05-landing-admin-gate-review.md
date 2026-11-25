# Code review — landing upload & admin gate (5047cc0..dd17d96)

**Date:** 2026-08-05
**Range:** `5047cc0a99e6` (base) → `dd17d963f381` (head), 7 files, +389/−24
**Method:** two independent reviewer subagents (general + security-focused), cross-checked
against live production RLS on `danatfuture-supabase-ozoxsa-db-1`.
**Status of range:** already pushed to `main` and deployed. Everything below belongs in a
follow-up commit.

## Commits reviewed

| SHA       | Claim                                                | Verdict                                      |
| --------- | ---------------------------------------------------- | -------------------------------------------- |
| `6a25a47` | persist shop card re-uploads on Edit Store           | **Incomplete** — see C1, I2                  |
| `9675494` | clear admin-only upload failures, stop hung spinners | Delivered, with gaps I3/I5                   |
| `ded8fa8` | block non-staff from the admin layout shell          | Delivered; defense-in-depth only             |
| `dd17d96` | prettier-fix, no behavior change                     | **True** — `git diff -w` is pure re-wrapping |

## Gates

`bun run typecheck` pass · `bun run test` pass (99 files / 712 tests — matches dd17d96's
claim exactly) · `bun run lint` was failing with 4 `prettier/prettier` errors in
`BrandLogo.test.tsx` and `SummaryCards.test.tsx`; both predate this range (base commit and
merged PR #72 respectively). Fixed separately.

## Live production enforcement (queried, not inferred)

```
storage.objects  ALL    {authenticated}  bucket_id='landing' AND has_role(uid(),'admin')
storage.objects  SELECT {public}         bucket_id='landing'
landing_media    ALL    {authenticated}  is_staff(uid())
landing_media    SELECT {public}         (open read)
```

`is_staff` = `admin|accountant|collector|readonly` (`db/migrations/01_schema_core.sql:114`).
Live policy text matches `db/migrations/19_landing_page.sql` and
`74_restore_storage_policies.sql`, so for this surface the migration files are trustworthy —
not something to assume in this repo, given the July server move wiped `storage.objects`
policies once already.

Live role census (queried directly against `public.user_roles`): `admin` ×2, `accountant` ×1,
`tenant` ×3. No `readonly`/`collector` accounts exist yet. The single real `accountant`
account is what makes C1 a live defect rather than a dormant one.

All buckets have `file_size_limit = NULL` and `allowed_mime_types = NULL`.

## Was there a privilege-escalation hole?

**No.** The production `AccessDenied` was RLS working as designed. A tenant's browser did
execute the admin landing component and issued Storage writes with its own JWT, but the
bucket policy rejected them. Nothing was written; nothing escalated.

`ded8fa8` is therefore defense-in-depth, not the fix that mattered. It is worth knowing
that it is **client-side only**: `src/routes/admin.tsx:16` sets `ssr: false` and the check
is a `useEffect`. There is no `beforeLoad` or `loader` anywhere in `src/routes/`, and no
server function in the landing write path at all — `src/hooks/useLandingSettings.ts` writes
straight to PostgREST from the browser. Had RLS been absent, this commit would have
provided zero protection.

## Critical

### C1 — client gate is `isStaff`, storage bucket requires `admin`

`src/routes/admin.settings.landing-page.tsx:133,199`, `src/components/admin/ImageSourceInput.tsx:79-82`, `src/lib/resolveLandingMedia.ts:53-58`

For an `accountant` (one real account exists today), `collector`, or `readonly` user:

1. `canManage` / `!permissions.isStaff` both pass → editor renders, upload enabled.
2. Upload → bucket RLS (`has_role admin`) denies → toast correctly says admin required.
3. `onChange(url)` at `ImageSourceInput.tsx:79` never fires → field keeps the **old**
   `storage_path`.
4. Save → `planLandingMediaResolution` matches that path → `reuse` → `cover_media_id`
   unchanged.
5. The `landing_media` write is gated on `is_staff`, so it **succeeds** → "Brand updated
   successfully", image unchanged.

That is exactly the silent-false-success `6a25a47` was written to eliminate. The new doc
comment at `ImageSourceInput.tsx:41` even states "Landing uploads require `has_role(admin)`"
while the gate beside it checks `isStaff`.

**Fix:** gate on `isAdmin` to match the bucket policy, and clear `value` on upload failure
so a stale URL cannot be re-saved as success.

### C2 — property images upload into the admin-only `landing` bucket

`src/components/admin/ImageSourceInput.tsx:47`, `src/routes/admin.properties.$id.tsx:244`, `src/routes/admin.properties.index.tsx:585`

**Attribution: pre-existing, not introduced here.** The `bucket = "landing"` default is
present at the base commit (`git show 5047cc0:…ImageSourceInput.tsx` line 37) and dates to
`b59a5f9`. This range _amplified_ it — the new 2 MB cap and the "landing images" error
wording now apply to property uploads — but did not create it.

`bucket = "landing"` is the default and neither property caller overrides it — both pass
only `folder="properties"`. **Live and in use, not latent:** the `landing` bucket holds
**13 objects under `properties/`** while the `property-images` bucket holds **0**.

Consequences: property photos inherit the landing bucket's `has_role(admin)` write policy,
so the same silent-failure class as C1 hits property management for non-admin staff; the
correctly-scoped `property-images` policy (`is_staff`, `74_restore_storage_policies.sql:120-134`)
is dead code; and the new 2 MB cap with its "landing images" wording now applies to property
photos and hero art.

**Fix:** pass `bucket="property-images"` at both property call sites. Consider removing the
default entirely so the bucket is always explicit.

## Important

| #   | Issue                                                                                                                                                                                                                                                                  | Location                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| I1  | Re-upload orphans the old `landing_media` row — stays `is_active: true`, and `src/routes/index.tsx:394` filters the public gallery on exactly that, so **both** old and new image render publicly. Storage object never reclaimed.                                     | `src/lib/resolveLandingMedia.ts:59-61`                            |
| I2  | Timeout does not cancel, only stops waiting. `@supabase/storage-js` `FileOptions` has no `signal`, so the upload completes unreferenced and a retry orphans another. An AbortController at the call site will not work — needs a custom `fetch` on the storage client. | `src/lib/landingImageUpload.ts:70-85`                             |
| I3  | A transient `user_roles` fetch error ejects a real admin from the whole shell: `roles ?? []` → `isStaff: false` with `isLoading: false`, indistinguishable from "you are a tenant". `permissions.error` is never consulted.                                            | `src/routes/admin.tsx:34-36`, `src/hooks/usePermissions.ts:59,64` |
| I4  | Error mapper reads only `.message` though its own test passes `statusCode: 403`. A 401 expired JWT maps to "requires an admin account" — sends a genuine admin chasing a phantom permissions bug. Branch on `statusCode` first.                                        | `src/lib/landingImageUpload.ts:31-56`                             |
| I5  | `useCompany()` escaped the `canManage` gating the other queries received.                                                                                                                                                                                              | `src/routes/admin.settings.landing-page.tsx:172`                  |

## Minor

- **M1** — 2 MB cap is client-only; every bucket has `file_size_limit = NULL`. UX, not a control.
- **M2** — `expect(ar).toMatch(/مسؤول|admin/i)` passes on the English string, so the Arabic
  branch is not actually tested. Drop the `|admin`. (`landingImageUpload.test.ts:33`)
- **M3** — no test covers the component wiring; the pure helpers can all pass while
  `ImageSourceInput` misuses them, which is precisely where C1 lives.
- **M4** — `readonly` role can write every landing table (`is_staff` includes it). Dormant —
  no such account exists — but the first one silently gains landing write.
- **M5** — `anon` and `authenticated` hold full DML on all five landing tables via Supabase
  default privileges; `19_landing_page.sql:271-277` grants only SELECT and nothing revokes
  the default. Predicates hold, so not exploitable today, but a dropped policy is an
  immediate total loss with no grant layer behind it.
- **M6** — `landing_page_sections` public read is `USING (true)`, unlike its four siblings;
  unpublished section config is readable by `anon`. Content only.

## Recommended follow-up, ranked

1. C1 + C2 — make the client predicate match the storage policy, and fix the bucket default.
2. I1 — deactivate or repoint the superseded `landing_media` row, else the fix trades
   "photo never saves" for "old photo never leaves the public gallery".
3. I3 — add `!permissions.error` to the redirect condition.
4. I4 — branch the error mapper on `statusCode`.
5. Longer term: move landing writes behind a server fn with `has_permission(uid,'landing.update')`.
   There is currently no server-side place a staff check could even be inserted.
6. Set `file_size_limit`/`allowed_mime_types` on `landing`, `branding`, `property-images`.
7. Explicitly `revoke insert, update, delete on … from anon, authenticated` — note `revoke
from public` does not reach those roles.

## Assessment

**Not ready as-is; needs a follow-up commit.** Commits 2–4 deliver their stated claims and
`ded8fa8` sits on top of real RLS rather than replacing it. But `6a25a47`'s fix is incomplete
in practice: the `isStaff`/`admin` mismatch reproduces the original silent-success symptom
for non-admin staff, C2 extends the same failure to property images, and the new
create-on-replace path leaves superseded images live on the public gallery.
