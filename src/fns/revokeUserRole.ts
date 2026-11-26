import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

/**
 * Revoke a role, and — for the `tenant` role — the tenant links that role
 * exists to serve.
 *
 * A tenant login is three rows, not one: the `user_roles` assignment, the
 * portal link `profiles.tenant_id` (which is what the portal actually reads),
 * and any `user_tenants` rows behind the "Linked tenants" count. Deleting only
 * the first left an account with no tenant role still linked to a tenant and
 * still counted, which is what was reported.
 *
 * These are three separate writes with no transaction between them —
 * service_role buys one round trip and one audit entry, not atomicity. They
 * are ordered so the `user_roles` row goes LAST: a failure part-way through
 * then leaves the role still granted, so pressing Revoke again is a clean
 * retry. Deleting the role row first (the original order) would instead leave
 * the exact broken state this function exists to fix — role gone, links
 * still present — on any failure after step one.
 *
 * Because the role deletion moved to last, the "does this assignment even
 * exist" check has to happen up front as a separate read: if it happened
 * after the tenant links were cleared, a call for a role the user never had
 * would destroy real links before discovering there was nothing to revoke.
 *
 * Revoking a managerial role deliberately touches neither link — an accountant
 * who also holds `tenant` keeps their portal access.
 */

const schema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "accountant", "collector", "readonly", "tenant"]),
});

export const revokeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    // Errors are thrown as `Error`, never `Response`: TanStack Start returns a
    // thrown Response to the caller instead of rejecting it.
    await requirePermission(context, {
      code: "users.delete",
      attempted: "user.revoke_role",
      refusal: "You do not have permission to revoke roles.",
      entityType: "user",
      entityId: data.userId,
    });

    const db = companyClient(requireRequestCompany().id);

    // Read-only check, first and separate from the delete below: it must
    // reject a call for a role the user doesn't hold BEFORE any tenant link
    // is touched, not after.
    const existing = await db
      .from("user_roles")
      .select("id")
      .eq("user_id", data.userId)
      .eq("role", data.role)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) throw new Error("Role assignment was not found or cannot be revoked.");

    let clearedTenantLink = false;
    let removedAssignments = 0;

    if (data.role === "tenant") {
      // `.not("tenant_id", "is", null)` makes the WHERE clause the evidence:
      // matching by id alone would return this row whether or not tenant_id
      // was already null, which is exactly how the previous version ended up
      // claiming "removed" for an account that had nothing to remove.
      const unlink = await db
        .from("profiles")
        .update({ tenant_id: null } as any)
        .eq("id", data.userId)
        .not("tenant_id", "is", null)
        .select("id");
      if (unlink.error) throw new Error(unlink.error.message);
      clearedTenantLink = ((unlink.data as unknown as unknown[] | null)?.length ?? 0) > 0;

      const assignments = await db
        .from("user_tenants" as any)
        .delete()
        .eq("user_id", data.userId)
        .select("id");
      if (assignments.error) throw new Error(assignments.error.message);
      removedAssignments = (assignments.data as unknown as unknown[] | null)?.length ?? 0;
    }

    // Deleted last: if this fails after the links above were cleared, the
    // role stays granted and a retry cleanly finishes the job, rather than
    // leaving a role-less account still linked (the original bug).
    const revoked = await db
      .from("user_roles")
      .delete()
      .eq("user_id", data.userId)
      .eq("role", data.role);
    if (revoked.error) throw new Error(revoked.error.message);

    await db.rpc("write_audit", {
      p_action: "user.role.revoke",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: { role: data.role },
      p_after: { cleared_tenant_link: clearedTenantLink, removed_assignments: removedAssignments },
      p_result: "success",
      p_error_code: null,
    });

    return { revoked: true as const, clearedTenantLink, removedAssignments };
  });
