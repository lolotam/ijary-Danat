import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { parseServerInput } from "@/lib/parseServerInput";
import { getAuthAdmin } from "@/platform/authAdmin.server";
import { requirePermission } from "@/fns/requirePermission";

/**
 * يوقف حساب مستخدم أو يعيد تفعيله، ويطبّق الحظر على مُصدِر الجلسات نفسه.
 *
 * Moving this write off the browser is the point: under RLS the browser could
 * only flip `profiles.is_active`, which nothing at the issuer reads. Setting
 * `auth.users.banned_until` via the GoTrue Admin API is what actually stops
 * new tokens being issued and kills existing sessions on their next refresh.
 *
 * The service role bypasses RLS, so the `users.update` permission check below
 * re-imposes, server-side, exactly the gate the replaced browser write had
 * from the `profiles_update_own_or_admin` policy
 * (db/migrations/03_phase1_permissions_audit.sql:397). Anything looser here
 * silently widens who can deactivate users.
 *
 * The two writes are not one transaction — the profile is in Postgres, the
 * ban is in GoTrue — so they are ordered so any partial failure lands on
 * "still locked out", never "flag says deactivated but tokens still work":
 * deactivate bans first and lifts the ban again if the profile write fails;
 * reactivate writes the profile first and lifts the ban second.
 */

const schema = z.object({
  userId: z.string().uuid(),
  isActive: z.boolean(),
});

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(schema, data))
  .handler(async ({ data, context }) => {
    // Errors are returned as flags, never thrown Responses: TanStack Start
    // resolves a thrown Response client-side instead of rejecting it.
    // The shared gate records the refusal; this fn's contract is a returned
    // flag, not a throw, so the gate's Error is turned back into one.
    try {
      await requirePermission(context, {
        code: "users.update",
        attempted: "user.set_active",
        refusal: "You do not have permission to update user status.",
        entityType: "user",
        entityId: data.userId,
      });
    } catch (refusal) {
      return { ok: false as const, error: (refusal as Error).message };
    }

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    // Read the row before touching it: the audit `before` must carry the
    // value actually stored, not `!isActive` inferred from the request. The
    // old browser hook guessed, and guessed wrong for every repeat toggle.
    const prior = await db.from("profiles").select("is_active").eq("id", data.userId).single();
    if (prior.error || !prior.data) {
      return { ok: false as const, error: prior.error?.message ?? "Profile not found." };
    }

    if (data.isActive) {
      // Reactivate: profile first, ban lift second. If the lift fails the
      // account reads "active" but stays locked — retryable, and never the
      // reverse (open while flagged inactive).
      const profileRes = await db
        .from("profiles")
        .update({ is_active: true } as any)
        .eq("id", data.userId);
      if (profileRes.error) {
        return { ok: false as const, error: profileRes.error.message };
      }

      const unban = await getAuthAdmin().updateUserById(data.userId, {
        ban_duration: "none",
      });
      if (unban.error) {
        return {
          ok: false as const,
          error: authErrorMessage(unban.error, "Failed to lift the ban on the account"),
        };
      }
    } else {
      // Deactivate: ban first, profile second. GoTrue blips then leave the
      // account active and unbanned — a clean retry — instead of the hole
      // this task exists to close: "deactivated" in the table, password
      // grant still live forever, nothing flagging the desync.
      const ban = await getAuthAdmin().updateUserById(data.userId, {
        ban_duration: "876000h",
      });
      if (ban.error) {
        return {
          ok: false as const,
          error: authErrorMessage(ban.error, "Failed to ban the account"),
        };
      }

      const profileRes = await db
        .from("profiles")
        .update({ is_active: false } as any)
        .eq("id", data.userId);
      if (profileRes.error) {
        const rollback = await getAuthAdmin().updateUserById(data.userId, {
          ban_duration: "none",
        });
        return {
          ok: false as const,
          error: rollback.error
            ? `Profile write failed (${profileRes.error.message}) and lifting the ban afterwards failed too (${authErrorMessage(rollback.error, "auth service error")}). The account is still banned — retry the operation.`
            : profileRes.error.message,
        };
      }
    }

    // Server-side audit via the RPC, not `logAuditForCurrentSession`: that
    // helper reads the browser session and throws without one
    // (src/lib/audit.ts:18-20). Argument names follow createAppUser exactly.
    const audit = await db.rpc("write_audit", {
      p_action: "user.status.update",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: { is_active: prior.data.is_active },
      p_after: { is_active: data.isActive },
      p_result: "success",
      p_error_code: null,
    });

    // The status change has already happened by this point, so a failed audit
    // must not be reported as a failed operation — the caller would refetch and
    // see the change it was just told did not occur. It is reported as an
    // applied change with no audit row, which is the thing an operator has to
    // know: `ok` stays true, `auditError` says the trail is incomplete.
    if (audit.error) {
      return { ok: true as const, auditError: audit.error.message };
    }

    return { ok: true as const };
  });
