import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { parseServerInput } from "@/lib/parseServerInput";
import { deleteAuthUser } from "@/platform/authAdmin.server";
import { requireRole } from "@/fns/requirePermission";

/**
 * Permanently delete a user account (admin only). Admins cannot delete
 * themselves.
 *
 * Every failure path throws an `Error`, never a `Response`. TanStack Start
 * returns a thrown `Response` to the caller instead of rejecting
 * (start-server-core marks it `x-tss-raw`, start-client-core hands it back), so
 * a `throw new Response("Forbidden", { status: 403 })` here resolved the
 * caller's `await` and fired its success toast while nothing was deleted. That
 * is the bug this file exists to fix; do not reintroduce the pattern.
 *
 * The return value is deliberately `{ deleted: true }` rather than bare data:
 * the caller asserts on it, so any future path that returns something else
 * cannot be mistaken for a completed delete.
 */

const schema = z.object({ userId: z.string().uuid() });

export const deleteAppUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(schema, data))
  .handler(async ({ data, context }) => {
    await requireRole(context, "admin", {
      attempted: "user.delete",
      refusal: "Only an admin may delete a user account.",
    });
    if (data.userId === context.userId) {
      throw new Error("You cannot delete your own account.");
    }

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const profile = await db
      .from("profiles")
      .select("username, display_name, tenant_id")
      .eq("id", data.userId)
      .maybeSingle();
    if (profile.error) throw new Error(profile.error.message);
    if (!profile.data) {
      throw new Error("User account was not found in this company.");
    }

    const deleteRes = await deleteAuthUser(data.userId);
    if (deleteRes.error) {
      throw new Error(authErrorMessage(deleteRes.error, "Failed to delete the auth user"));
    }

    // `profiles.id references auth.users(id) on delete cascade`, so this read
    // should find nothing. It is here because "the toast was green and the row
    // is still there" is precisely the failure being fixed — the delete is
    // confirmed rather than assumed.
    const survivor = await db.from("profiles").select("id").eq("id", data.userId).maybeSingle();
    if (survivor.data) {
      const cleanup = await db.from("profiles").delete().eq("id", data.userId);
      if (cleanup.error) {
        throw new Error(
          `The sign-in account was deleted but its profile row could not be removed: ${cleanup.error.message}`,
        );
      }
    }

    await db.rpc("write_audit", {
      p_action: "user.delete",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: profile.data ?? null,
      p_after: null,
      p_result: "success",
      p_error_code: null,
    });

    return { deleted: true as const, userId: data.userId };
  });
