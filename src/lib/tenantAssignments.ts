/**
 * Decides whether `EditUserDialog`'s managerial-account save should include
 * `tenantIds`. The server (`updateAppUser`) treats a *present* `tenantIds`
 * key as "replace this user's user_tenants rows wholesale" —
 * delete-then-insert, new row ids, `created_by` reassigned — so this must be
 * `true` only when the selection is both known and actually different from
 * what was loaded.
 *
 * `assigned === undefined` means "not loaded yet" (see EditUserDialog's
 * assignedTenantIds prop and its call site in admin.settings.users.tsx) and
 * must never be treated as "no links". That was the exact regression the
 * first cut of this fix introduced: `useUserTenants` omits a user from its
 * Map entirely when they have zero rows, so a managerial user with no
 * existing assignments could never get their *first* assignment saved —
 * there was no way, at the call site, to tell "unknown" apart from "empty",
 * and this decision silently no-opped under a green success toast.
 *
 * The comparison is order-insensitive because the selector's order carries
 * no meaning — reordering the same tenants is not a change worth a write.
 */
export function shouldSendTenantIds(current: string[], assigned: string[] | undefined): boolean {
  if (assigned === undefined) return false;
  return [...current].sort().join("|") !== [...assigned].sort().join("|");
}
