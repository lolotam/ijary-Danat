# Users & Roles fixes + Gmail delete propagation — design

Date: 2026-08-01

Five reported problems in **Settings → Users and Roles**, plus one in the Gmail
inbox. Three of the five have confirmed root causes verified against the
production database and GoTrue logs; they are recorded here because the evidence
is what justifies the shape of each fix.

## Evidence gathered before designing

Read from production (`ssh-danatfuture-mcp`, `danatfuture-supabase-ozoxsa-db-1`)
on 2026-08-01.

| Fact                                         | Value                                                               |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `DELETE` requests reaching GoTrue in 30 days | **0**                                                               |
| `POST /admin/users` in 30 days               | 1 (the 2026-07-31 user creation)                                    |
| Profiles / auth users                        | 5 / 5, none deleted                                                 |
| Non-cascade FKs referencing `auth.users`     | none (nothing can block a delete)                                   |
| `b88a4ef2` (`waleed`) roles                  | `accountant` only — `tenant` **was** revoked                        |
| `b88a4ef2` `profiles.tenant_id`              | still `73786c22-7a1d-4916-bea0-bece4a42a7ab`                        |
| `b88a4ef2` `user_tenants` rows               | 1 (same tenant) → badge shows `1`                                   |
| Live Gmail grant scopes                      | `gmail.send readonly userinfo.email openid` — **no `gmail.modify`** |
| `profiles.phone` populated                   | 0 of 5                                                              |

### The framework behaviour behind "deleted successfully" but nothing deleted

`src/fns/*` signals authorization failures with
`throw new Response("Forbidden", { status: 403 })`. TanStack Start does not turn
that into a client-side rejection:

- `@tanstack/start-server-core/dist/esm/server-functions-handler.js:67-70` —
  a thrown `Response` is caught, stamped with `x-tss-raw: true`, and returned.
- `@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js:139` —
  `if (response.headers.get("x-tss-raw") === "true") return response;`

The client **returns** the `Response`; it does not throw. The caller's `await`
resolves, and the `toast.success()` on the next line fires. A thrown `Error`
rejects correctly. A thrown `Response` reports success.

Combined with zero `DELETE` requests reaching GoTrue, `deleteAppUser` exited at
one of its early guards every time and the UI reported success anyway.

**Scope note:** roughly twenty other files in `src/fns/` throw `Response` for
403/400/409 and carry the same exposure. Fixing all of them is not part of this
work. Only the files this spec touches are converted.

---

## 1. Revoking the tenant role clears both tenant links

**Problem.** `useRevokeRole` deletes one `user_roles` row and nothing else.
`profiles.tenant_id` and `user_tenants` survive, so the "Linked tenants" badge
stays at 1 and the user stays in the Tenants tab.

The audit log shows `user.tenants.assign` → `user.role.grant` →
`user.tenant.update` within 68 seconds by one actor against one tenant: a single
intent expressed through the three mechanisms the UI offers. Revocation must
undo all three.

**Decision (user-approved).** Revoking `tenant` clears both links.

**Design.** New server function `src/fns/revokeUserRole.ts`, admin-gated,
running under `service_role`:

1. Delete the `user_roles` row. Absent row → error (preserves today's
   "Role assignment was not found" behaviour).
2. When `role === "tenant"`: set `profiles.tenant_id = null` and delete every
   `user_tenants` row for that user.
3. One `write_audit` entry recording all three before/after values.
4. Return `{ revoked: true, clearedTenantLink: boolean, removedAssignments: number }`.

Three sequential RLS'd browser writes have no transaction; a partial failure
produces exactly the inconsistent state being reported. `createAppUser` already
sets the precedent for multi-step user mutations server-side.

`useRevokeRole` becomes a thin wrapper over the server function and invalidates
**both** `["users-with-roles"]` and `["user-tenants"]`. The missing second
invalidation is an independent reason the badge would not refresh.

`RevokeRoleDialog` names the extra removals before confirming.

**Accepted side effect.** Clearing `tenant_id` drops the user out of the Tenants
tab, whose filter is `roles.includes("tenant") || tenant_id != null`. Correct,
but it reads as the row "moving".

## 2. Mobile / WhatsApp number on both forms

**Problem.** Neither form captures a number, so mobile login cannot work for a
managerial user. `profiles.phone` exists and migration 65's
`find_profiles_by_phone_digits` already searches it — the column has simply
never been written to.

**Design.** Add a Mobile / WhatsApp field to `CreateUserDialog` (both kinds) and
`EditUserDialog`. `createAppUser` and `updateAppUser` accept `phone`, validate
it with `nationalPhoneDigits` (rejecting anything under 8 digits, matching what
login can resolve), and write `profiles.phone`.

**Collision guard (user-approved: block on save).** Login matches the **last 8
digits** across `profiles.phone` and `tenants.mobile` and refuses when more than
one profile matches. Storing a number that collides silently disables mobile
login for both parties.

**Migration 66** adds `public.find_phone_conflicts(_digits text, _exclude_profile uuid)`
returning `(kind text, id uuid, label text)`, mirroring migration 65's
digits-only last-8 projection exactly so the guard rejects precisely what login
would refuse. Two conflict kinds:

- `profile` — another profile whose `phone`, or whose linked tenant's `mobile`,
  matches. This is the condition that actually breaks login.
- `tenant` — a tenant whose `mobile` matches but who has no portal account yet.
  Not a live collision, but the number most likely to be mistyped, and the
  collision would otherwise appear months later when that portal login is created.

`_exclude_profile` prevents a user colliding with themselves. A tenant-portal
user whose own tenant record carries the same number is already one profile row
in migration 65's projection, so no self-collision arises there.

`EXECUTE` granted to `service_role` only, matching migration 65 — the same
enumeration reasoning applies.

## 3. Edit form matches Add form

**Problem.** `EditUserDialog` has four fields; `CreateUserDialog` has up to seven.

**Design.** `EditUserDialog` renders the same fields in the same order:
username, display name, email, mobile, password (blank = keep current), role,
tenant selector.

**The multi-role trap.** The Add form grants exactly one role, but a user can
hold several — `b88a4ef2` held `accountant` and `tenant` simultaneously. A plain
single-role `<Select>` would silently drop the second role on every save.

So the role select is scoped to the user's **managerial** role only. Changing it
swaps that one role and leaves `tenant` and its links untouched. Role changes
route through the same grant/revoke path the role badges use, so exactly one
code path can change a role.

The tenant selector follows the Add form's rule: single-select for a tenant
account (writes `profiles.tenant_id`), multi-select for a managerial account
when the caller holds `users.assign_tenants` (writes `user_tenants`). "Kind" is
derived from `roles.includes("tenant") || tenant_id != null`, not assumed
exclusive.

`updateAppUser` grows optional `phone`, `role` and `tenantIds`, applied
server-side in one call.

## 4. Deletion actually deletes

**Root cause.** The `x-tss-raw` behaviour documented above: `deleteAppUser`'s
403 guard resolves as success on the client.

**Design.**

- `deleteAppUser` throws `Error`, never `Response`, so every failure rejects.
- After `auth.admin.deleteUser`, re-read to confirm the auth user is gone and
  the `profiles` row cascaded away. A surviving profile row is deleted
  explicitly. Only then return `{ deleted: true }`.
- `confirmDelete` asserts `result?.deleted === true` before the success toast;
  an unexpected payload is an error, not a green tick.

Robust whichever guard was firing. The exact branch is confirmed by reproducing
against the running app during implementation and reported to the user.

## 5. Deleting a message deletes it in Gmail

**Problem.** `useDeleteGmailMessages` deletes the local row only. The next cron
tick re-lists the same 30-day window and re-inserts it.

**Decision (user-approved).** Move to Trash — recoverable, and a far smaller
OAuth ask than the `https://mail.google.com/` scope permanent deletion needs.

**Design.**

- `GMAIL_SCOPE` gains `https://www.googleapis.com/auth/gmail.modify`.
  `grantCanModify(scope)` added beside `grantCanSend` in
  `src/lib/gmailClient.server.ts`.
- New `src/fns/gmailTrashMessages.ts`, admin-gated to mirror migration 50's
  delete policy (`has_role(auth.uid(), 'admin')` — deletion is admin-only there,
  while read and mark-read are staff-level). The function runs under
  `service_role`, so that check is explicit rather than inherited from RLS.
  For each local row id: resolve **Gmail's own** message id from
  `raw_payload.id` — the `message_id` column is the RFC 822 header with a
  `gmail:<id>` fallback (`gmailSyncJob.ts:106`), not Gmail's id — then
  `POST /messages/{gmailId}/trash`, and delete the local row **only on success**.
- **Fails closed.** A failed trash keeps the local row and reports why. Deleting
  locally after a failed trash would reproduce the reported bug at higher cost.
  Returns `{ trashed: number, failed: Array<{ id, reason }> }`.
- A grant without `modify` refuses the whole call up front with the message
  `describeGmailApiError` already produces for the equivalent send case.

**Why this stops the resurrection.** `users.messages.list` excludes TRASH unless
`includeSpamTrash=true`, which `gmailSyncJob` does not set. Verified empirically
during implementation, not assumed.

**Operational requirement.** Google never adds scopes to an existing refresh
token. The live grant has no `modify`, so the admin must **Disconnect → Connect
Gmail** once in Settings → Integrations after deploy — the same one-time step
`gmail.send` required. Until then, delete refuses with that instruction rather
than failing opaquely.

## Verification

- Vitest beside each server function: `revokeUserRole`, `deleteAppUser`,
  `gmailTrashMessages`, and phone-conflict validation.
- Migration 66 verified with `bun run test:db` (clean database from scratch).
- `bun run lint && bun run typecheck && bun run test`.
- Live check against production data for the revoke and delete paths.
- New i18n keys added to both `ar` and `en` dictionaries.
