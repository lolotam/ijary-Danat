import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { Database } from "@/integrations/supabase/database.types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { parseServerInput } from "@/lib/parseServerInput";
import { notifyUserCredentials, type CredentialSendResult } from "@/fns/notifyUserCredentials";
import { normalisePhoneForSave } from "@/lib/phoneConflicts.server";
import { createAuthUser, deleteAuthUser } from "@/platform/authAdmin.server";
import { syncTenantContact } from "@/fns/syncTenantContact";
import { isTenantAccountConflict, TENANT_ALREADY_HAS_ACCOUNT } from "@/lib/tenantPortalAccount";
import { TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";
import { requireRole } from "@/fns/requirePermission";
import {
  assertUsernameAvailable,
  emailTakenError,
  isEmailTaken,
  isUsernameConflict,
  usernameTakenError,
} from "@/lib/userConflicts.server";

/**
 * ينشئ حسابًا إداريًا أو حساب بوابة لمستأجر.
 *
 * Create a managerial user or a tenant portal user.
 *
 * - Uses Supabase admin API so the caller (admin) is not signed in as the new user.
 * - Username is converted to an email of the form `<username>@users.local` to
 *   match the loginIdentifierToEmail() helper used by the sign-in flow.
 * - For tenant portal accounts, the new profile is linked to `tenant_id` and
 *   the `tenant` role is granted.
 * - For managerial accounts a role is required and granted.
 */

const schema = z.object({
  kind: z.enum(["managerial", "tenant"]),
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, "Username must be alphanumeric"),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(120),
  email: z.string().email(),
  phone: z.string().trim().max(32).optional().nullable(),
  role: z.enum(["admin", "accountant", "collector", "readonly"]).optional().nullable(),
  tenantId: z.string().uuid().optional().nullable(),
});

/**
 * حالة تسليم بيانات الدخول كما تظهر للمسؤول بعد إنشاء الحساب.
 *
 * `paused` and `no-recipients` are not errors anywhere in the notification
 * stack — they are ordinary returns — which is exactly why they need naming
 * here. Both leave the customer uninformed while the account creation reports
 * success, and they are the two cases a plain try/catch cannot see.
 *
 * `tenant-paused` is the same silence with a different cause: the tenant's own
 * notifications are switched off, so the row was written as `skipped` with the
 * pause reason. It is a tenant-level switch, not a workflow one.
 */
export type CredentialDelivery = {
  status: "sent" | "paused" | "tenant-paused" | "no-recipients" | "failed";
  reason: string | null;
};

/**
 * يترجم نتيجة notifyUserCredentials إلى حالة تسليم صريحة.
 *
 * **A returned id does not mean the message was delivered, and not every id is
 * aimed at the account owner.** Review finding on
 * PR #206: `dispatchNotificationRecord` catches a provider rejection and
 * *returns* the notification row with `state: 'failed'` rather than throwing,
 * so a refused SMTP or WhatsApp send still yields an id. Reading `ids.length`
 * alone would have reported the exact failure this function exists to surface
 * as a success — so the rows are read back and their state is what decides.
 *
 * At least one `sent` row counts as delivered: where a tenant gets both an
 * email and a WhatsApp message and only one lands, the person was still told,
 * and warning the admin would be a false alarm.
 *
 * Every row skipped for the tenant's own pause is a different story again: the
 * switch is on the tenant, so the admin has to know that unpausing it (or
 * resending later) is what would deliver the password.
 */
async function describeDelivery(
  db: SupabaseClient<Database>,
  notify: CredentialSendResult,
): Promise<CredentialDelivery> {
  if (notify.skipped) return { status: "paused", reason: notify.reason ?? null };
  // Only the rows aimed at the account owner. The managerial path also mails a
  // copy to the company and admin addresses; a delivered copy says nothing
  // about whether the person who needs the password received anything.
  if (notify.recipientIds.length === 0) return { status: "no-recipients", reason: null };

  const { data, error } = await db
    .from("notifications")
    .select("state, failure_reason")
    .in("id", notify.recipientIds);
  if (error) {
    // The send itself may well have worked; what failed is our ability to say
    // so. Reported as a failure because an admin who is told to check is in a
    // better position than one who is told it went fine.
    return { status: "failed", reason: error.message };
  }

  const rows = data ?? [];
  const allPaused =
    rows.length > 0 &&
    rows.every((row) => row.state === "skipped" && row.failure_reason === TENANT_PAUSED_REASON);
  if (allPaused) return { status: "tenant-paused", reason: null };
  if (rows.some((row) => row.state === "sent")) return { status: "sent", reason: null };
  return {
    status: "failed",
    reason: rows.map((row) => row.failure_reason).find(Boolean) ?? null,
  };
}

/**
 * يكتب صف تدقيق عندما لا تصل بيانات الدخول إلى صاحب الحساب.
 *
 * The creation itself already wrote a `user.create` success row; without this
 * second row the audit trail asserts an account was created and says nothing
 * about the half of the operation that failed.
 */
async function recordCredentialSendFailure(
  db: SupabaseClient<Database>,
  userId: string,
  username: string,
  delivery: CredentialDelivery,
): Promise<void> {
  const { error } = await db.rpc("write_audit", {
    p_action: "user.credentials_send",
    p_entity_type: "user",
    p_entity_id: userId,
    p_before: null,
    p_after: { username, reason: delivery.reason },
    p_result: "failure",
    p_error_code: delivery.status,
  });
  if (error) console.error("Credential-send audit write failed", error.message);
}

export const createAppUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(schema, data))
  .handler(async ({ data, context }) => {
    // Only admins can create users
    await requireRole(context, "admin", {
      attempted: "user.create",
      refusal: "Only an admin may create a user account.",
    });

    if (data.kind === "tenant" && !data.tenantId) {
      throw new Error("tenantId is required for tenant portal users");
    }
    if (data.kind === "managerial" && !data.role) {
      throw new Error("role is required for managerial users");
    }

    const company = requireRequestCompany();
    const db = companyClient(company.id);

    // One portal login per tenant. The create dialog already hides linked
    // tenants, but its list can be stale. Checked before the auth user exists
    // so the usual refusal has nothing to undo; two admins saving at once both
    // pass it, and migration 224's unique index refuses the second upsert.
    if (data.kind === "tenant") {
      const linked = await db
        .from("profiles")
        .select("id")
        .eq("tenant_id", data.tenantId!)
        .limit(1);
      if (linked.error) throw new Error(linked.error.message);
      if (linked.data?.length) {
        throw new Error(TENANT_ALREADY_HAS_ACCOUNT);
      }
    }

    // Checked before the auth user is created: a collision found afterwards
    // would mean rolling back an account that already exists.
    await assertUsernameAvailable(data.username, null);
    const phone = await normalisePhoneForSave(
      data.phone,
      null,
      data.kind === "tenant" ? (data.tenantId ?? null) : null,
    );

    const email = data.email.toLowerCase();

    // 1. Create auth user (email-confirmed so they can sign in immediately)
    const createRes = await createAuthUser({
      email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        company_id: company.id,
        username: data.username,
        display_name: data.displayName,
      },
    });
    if (createRes.error && isEmailTaken(createRes.error)) throw await emailTakenError(email);
    if (createRes.error || !createRes.data.user) {
      throw new Error(
        createRes.error
          ? authErrorMessage(createRes.error, "Failed to create auth user")
          : "Failed to create auth user",
      );
    }
    const userId = createRes.data.user.id;

    // 2. Upsert profile
    const profileRes = await db
      .from("profiles")
      .upsert({
        id: userId,
        company_id: company.id,
        username: data.username,
        display_name: data.displayName,
        email,
        phone,
        tenant_id: data.kind === "tenant" ? data.tenantId! : null,
        is_active: true,
      } as any)
      .select("*")
      .single();
    if (profileRes.error) {
      // Roll back auth user on failure
      await deleteAuthUser(userId);
      if (isUsernameConflict(profileRes.error)) {
        throw usernameTakenError(data.username);
      }
      throw new Error(
        isTenantAccountConflict(profileRes.error)
          ? TENANT_ALREADY_HAS_ACCOUNT
          : profileRes.error.message,
      );
    }

    // 3. Grant role
    const role = data.kind === "tenant" ? "tenant" : data.role!;
    const roleRes = await db
      .from("user_roles")
      .insert({ company_id: company.id, user_id: userId, role, granted_by: context.userId } as any);
    if (roleRes.error) {
      await deleteAuthUser(userId);
      throw new Error(roleRes.error.message);
    }

    // 4. If tenant, enable the portal and mirror the account's contact details
    // onto the tenant record. Both run *after* the account exists, so neither
    // may fail the call — an error would strand an account nobody can find.
    // Each failure has its own flag so the dialog warns about the right thing
    // (D10): a portal that stayed off means the tenant cannot sign in, which is
    // not the same as an email that was not mirrored.
    let tenantPortalEnabled = true;
    let tenantContactSynced = true;
    if (data.kind === "tenant") {
      const portalRes = await db
        .from("tenants")
        .update({ tenant_portal_enabled: true })
        .eq("id", data.tenantId!);
      if (portalRes.error) {
        console.error("tenant_portal_enabled update failed", portalRes.error.message);
        tenantPortalEnabled = false;
      }
      const contactSync = await syncTenantContact(
        data.tenantId!,
        {
          email,
          phone: phone ?? undefined,
        },
        company.id,
      );
      if (!contactSync.synced) {
        console.error("Tenant contact sync failed", contactSync.error);
        tenantContactSynced = false;
      }
    }

    // 5. Audit
    await db.rpc("write_audit", {
      p_action: "user.create",
      p_entity_type: "user",
      p_entity_id: userId,
      p_before: null,
      p_after: { kind: data.kind, username: data.username, role },
      p_result: "success",
      p_error_code: null,
    });

    // 6. Credentials notifications.
    //
    // Still best-effort — the account exists by now, and failing the whole call
    // would leave an account nobody can find. But the outcome is *returned*
    // rather than only logged: a console line the admin never sees meant an
    // account reported as created while the customer was told nothing, and the
    // gap only surfaced when they phoned in.
    let credentialDelivery: CredentialDelivery;
    try {
      const notify = await notifyUserCredentials({
        kind: data.kind,
        username: data.username,
        password: data.password,
        displayName: data.displayName,
        email: email,
        // The normalised number the account was created with. The tenant path
        // still prefers the tenant record's whatsapp/mobile and uses this only
        // when that record carries neither.
        mobile: phone,
        tenantId: data.kind === "tenant" ? data.tenantId : null,
      });
      credentialDelivery = await describeDelivery(db, notify);
    } catch (error) {
      console.error("Failed to send user credentials notifications", error);
      credentialDelivery = {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (credentialDelivery.status !== "sent") {
      await recordCredentialSendFailure(db, userId, data.username, credentialDelivery);
    }

    return {
      userId,
      username: data.username,
      credentialDelivery,
      tenantPortalEnabled,
      tenantContactSynced,
    };
  });
