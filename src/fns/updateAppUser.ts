import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { parseServerInput } from "@/lib/parseServerInput";
import { normalisePhoneForSave } from "@/lib/phoneConflicts.server";
import { getAuthAdmin } from "@/platform/authAdmin.server";
import type { AppRole, TablesUpdate } from "@/integrations/supabase/database.types";
import { syncTenantContact } from "@/fns/syncTenantContact";
import { isTenantAccountConflict, TENANT_ALREADY_HAS_ACCOUNT } from "@/lib/tenantPortalAccount";
import { requireRole } from "@/fns/requirePermission";
import {
  assertUsernameAvailable,
  emailTakenError,
  isEmailTaken,
  isUsernameConflict,
  usernameTakenError,
} from "@/lib/userConflicts.server";

/**
 * يحدّث بيانات حساب قائم (للمدير فقط).
 *
 * Update an existing user's account details (admin only).
 * Password/email changes go through the Supabase admin API so they apply to
 * the auth user, not just the profile row.
 */

const schema = z.object({
  userId: z.string().uuid(),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric")
    .optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  password: z.string().min(8).max(128).optional(),
  /** The user's managerial role. Swapped, never merged — see the handler. */
  role: z.enum(["admin", "accountant", "collector", "readonly"]).optional().nullable(),
  /** Portal link for a tenant account (`profiles.tenant_id`). */
  tenantId: z.string().uuid().optional().nullable(),
  /** Managerial multi-tenant switcher rows (`user_tenants`). */
  tenantIds: z.array(z.string().uuid()).optional(),
});

export const updateAppUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(schema, data))
  .handler(async ({ data, context }) => {
    await requireRole(context, "admin", {
      attempted: "user.update",
      refusal: "Only an admin may update a user account.",
    });

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    // The profile's current tenant link is read once, before any durable
    // write: it decides both which tenant the phone-conflict check excludes
    // and which tenant the contact sync targets when this request does not
    // move the link itself. Skipped when neither needs it.
    let currentTenantId: string | null = null;
    if (data.phone !== undefined || data.tenantId === undefined) {
      const currentProfile = await db
        .from("profiles")
        .select("tenant_id")
        .eq("id", data.userId)
        .single();
      if (currentProfile.error) throw new Error(currentProfile.error.message);
      currentTenantId = currentProfile.data.tenant_id;
    }

    // `undefined` means "the form did not send this field"; an empty string
    // means "the admin cleared it". Only the second should null the column.
    //
    // The conflict check must run against the tenant this save is landing on,
    // not necessarily the one already stored: an admin can change tenantId
    // and phone in the same request, and checking against the stale
    // tenant_id could wrongly refuse — or wrongly allow — the save. So the
    // incoming tenantId wins whenever it was actually sent (`!== undefined`
    // — `null` is a meaningful "cleared the link" value here, not "absent"),
    // and only falls back to the profile's current tenant_id when tenantId
    // was not part of this request at all.
    let phone: string | null | undefined;
    if (data.phone !== undefined) {
      const excludeTenantId = data.tenantId !== undefined ? data.tenantId : currentTenantId;
      phone = await normalisePhoneForSave(data.phone, data.userId, excludeTenantId);
    }

    const authEmail =
      data.email && data.email.length
        ? data.email.toLowerCase()
        : data.username
          ? `${data.username.toLowerCase()}@users.local`
          : undefined;

    // Before any auth write: a re-link refused by migration 224 after the email
    // or password had already changed would fail the save yet keep the new
    // credentials. The unique index still catches a concurrent re-link.
    if (data.tenantId) {
      const linked = await db
        .from("profiles")
        .select("id")
        .eq("tenant_id", data.tenantId)
        .neq("id", data.userId)
        .limit(1);
      if (linked.error) throw new Error(linked.error.message);
      if (linked.data?.length) throw new Error(TENANT_ALREADY_HAS_ACCOUNT);
    }

    // Same reason: a taken username used to be refused by the profile write
    // below, after the login's email and password had already been changed.
    if (data.username) await assertUsernameAvailable(data.username, data.userId);

    const authUpdates: { email?: string; password?: string; user_metadata?: object } = {};
    if (authEmail) authUpdates.email = authEmail;
    if (data.password) authUpdates.password = data.password;
    if (data.username || data.displayName) {
      authUpdates.user_metadata = {
        ...(data.username ? { username: data.username } : {}),
        ...(data.displayName ? { display_name: data.displayName } : {}),
      };
    }
    if (Object.keys(authUpdates).length) {
      const authRes = await getAuthAdmin().updateUserById(data.userId, authUpdates);
      if (authRes.error) {
        if (authEmail && isEmailTaken(authRes.error)) throw await emailTakenError(authEmail);
        throw new Error(authErrorMessage(authRes.error, "Failed to update the auth user"));
      }
    }

    const profileUpdates: TablesUpdate<"profiles"> = {};
    if (data.username) profileUpdates.username = data.username;
    if (data.displayName) profileUpdates.display_name = data.displayName;
    if (authEmail) profileUpdates.email = authEmail;
    if (phone !== undefined) profileUpdates.phone = phone;
    // `undefined` means the form did not send the field; `null` means the admin
    // cleared the portal link, and only the second should write.
    if (data.tenantId !== undefined) profileUpdates.tenant_id = data.tenantId;
    if (Object.keys(profileUpdates).length) {
      const profileRes = await db.from("profiles").update(profileUpdates).eq("id", data.userId);
      if (profileRes.error) {
        if (isUsernameConflict(profileRes.error)) {
          throw usernameTakenError(data.username!);
        }
        // Re-linking to a tenant that already has an account hits migration 224.
        throw new Error(
          isTenantAccountConflict(profileRes.error)
            ? TENANT_ALREADY_HAS_ACCOUNT
            : profileRes.error.message,
        );
      }
    }

    // Relinking a tenant portal account to a (possibly different) tenant must
    // enable that tenant's portal, exactly as createAppUser does at account
    // creation — otherwise the portal refuses the user with "Tenant portal
    // disabled" and nothing on this screen explains why. Best-effort, same as
    // createAppUser: this must not fail the whole save, and the previously
    // linked tenant's portal is left alone — other accounts may still use it.
    if (data.tenantId) {
      await db.from("tenants").update({ tenant_portal_enabled: true }).eq("id", data.tenantId);
    }

    /*
     * Role changes swap the *managerial* role only.
     *
     * A user can hold several roles at once — an accountant who also holds
     * `tenant` is a real shape in this database. Treating the form's single
     * select as the whole truth would delete the tenant role on every save, and
     * with it the portal access that role represents. So the swap is scoped to
     * the managerial roles and `tenant` is left to the grant/revoke controls,
     * which are the only things that should ever touch it.
     */
    if (data.role) {
      const existing = await db.from("user_roles").select("role").eq("user_id", data.userId);
      if (existing.error) throw new Error(existing.error.message);

      const managerial = (existing.data ?? [])
        .map((row) => row.role)
        .filter((role): role is Exclude<AppRole, "tenant"> => role !== "tenant");

      if (!managerial.includes(data.role)) {
        if (managerial.length) {
          const dropped = await db
            .from("user_roles")
            .delete()
            .eq("user_id", data.userId)
            .in("role", managerial);
          if (dropped.error) throw new Error(dropped.error.message);
        }
        const granted = await db.from("user_roles").insert({
          company_id: company.id,
          user_id: data.userId,
          role: data.role,
          granted_by: context.userId,
        });
        if (granted.error) throw new Error(granted.error.message);
      }
    }

    // Replace rather than diff: the lists are small and a full replace lands on
    // the same result whatever the previous state was.
    if (data.tenantIds !== undefined) {
      const cleared = await db
        .from("user_tenants" as any)
        .delete()
        .eq("user_id", data.userId);
      if (cleared.error) throw new Error(cleared.error.message);

      if (data.tenantIds.length) {
        const linked = await db.from("user_tenants" as any).insert(
          data.tenantIds.map((tenantId) => ({
            company_id: company.id,
            user_id: data.userId,
            tenant_id: tenantId,
            created_by: context.userId,
          })) as any,
        );
        if (linked.error) throw new Error(linked.error.message);
      }
    }

    await db.rpc("write_audit", {
      p_action: "user.update",
      p_entity_type: "user",
      p_entity_id: data.userId,
      p_before: null,
      p_after: {
        username: data.username ?? null,
        display_name: data.displayName ?? null,
        email: authEmail ?? null,
        phone: phone ?? null,
        password_changed: Boolean(data.password),
        role: data.role ?? null,
        tenant_id: data.tenantId ?? null,
        tenant_ids: data.tenantIds ?? null,
      },
      p_result: "success",
      p_error_code: null,
    });

    // Mirror the account's contact details onto the tenant record. The target
    // is the *effective post-update* tenant — the payload's tenantId when the
    // request moved the portal link, else the profile's current one — and the
    // sync is skipped entirely when that is null (no tenant to sync to). Like
    // the portal flag above, this runs after the save has landed, so a failure
    // is returned as `tenantContactSynced: false` for the UI to warn about
    // rather than failing a call whose writes all succeeded.
    const effectiveTenantId = data.tenantId !== undefined ? data.tenantId : currentTenantId;
    let tenantContactSynced = true;
    if (effectiveTenantId) {
      const contactSync = await syncTenantContact(effectiveTenantId, {
        email: data.email ? data.email.toLowerCase() : undefined,
        phone: phone ?? undefined,
      });
      if (!contactSync.synced) {
        console.error("Tenant contact sync failed", contactSync.error);
        tenantContactSynced = false;
      }
    }

    return { updated: true as const, userId: data.userId, tenantContactSynced };
  });
