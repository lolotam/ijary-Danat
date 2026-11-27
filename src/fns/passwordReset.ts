import { createHash, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  classifyIdentifier,
  loginIdentifierToEmail,
  nationalPhoneDigits,
  syntheticAuthEmail,
} from "@/auth/loginIdentity";
import { companyClient } from "@/company/companyClient.server";
import { companyOrigin } from "@/company/companyUrl.server";
import { requireRequestCompany, type RequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { recordFailedLoginAttempt } from "@/fns/loginAudit";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, LocaleCode } from "@/integrations/supabase/database.types";
import { authErrorMessage } from "@/lib/authErrorMessage";
import { passwordResetTemplate } from "@/lib/emailTemplates";
import { parseServerInput } from "@/lib/parseServerInput";
import { signOutAuthUser, updateAuthUserById } from "@/platform/authAdmin.server";

/**
 * إعادة تعيين كلمة المرور من التطبيق: طلب الرابط، وتأكيد الرابط، والتغيير الإجباري بعد أول دخول.
 *
 * Password reset is an application flow, not GoTrue's recovery mail (research.md
 * R3): every account's GoTrue address is synthetic and undeliverable, so the
 * platform emails a single-use token of its own and sets the password through
 * the GoTrue admin path (`src/platform/authAdmin.server.ts`). Only a SHA-256
 * digest of the token is stored (migration 314); the plaintext exists solely in
 * the outgoing message body.
 *
 * The identifier → account lookup deliberately mirrors `findAccountEmail` in
 * `src/fns/signInWithIdentifier.ts` (that helper is module-private and its file
 * is outside this slice): same rules, shared primitives from
 * `src/auth/loginIdentity.ts` — ambiguity refused, resolution inside the host
 * company only.
 */

/** مدة صلاحية رابط الاستعادة بالدقائق قبل انتهاء صلاحيته. */
const RESET_TOKEN_TTL_MINUTES = 30;

/** نافذة الحد الأقصى لطلبات الاستعادة لنفس الحساب بالدقائق. */
const RESET_CAP_WINDOW_MINUTES = 15;

/** الحد الأقصى لرموز الاستعادة المسموح بإصدارها للحساب خلال نافذة الحد. */
const RESET_CAP_MAX_TOKENS = 3;

/** رمز قالب رسالة الاستعادة في `notification_templates`. */
const RESET_TEMPLATE_CODE = "password-reset";

const requestSchema = z.object({ identifier: z.string().trim().min(1).max(320) });
const confirmSchema = z.object({
  token: z.string().trim().min(1).max(200),
  password: z.string().min(8).max(128),
});
const changeSchema = z.object({
  currentPassword: z.string().min(1).max(128).optional(),
  password: z.string().min(8).max(128),
});

/** الحساب المؤهَّل لاستعادة كلمة المرور داخل شركة المضيف. */
interface ResetAccount {
  id: string;
  email: string;
  displayName: string;
  locale: LocaleCode;
}

/** بيانات ملف المستخدم المطلوبة للتحقق من الشركة ووسم التغيير الإجباري. */
interface CallerProfile {
  mustChangePassword: boolean;
  email: string | null;
  username: string | null;
}

/**
 * يحوّل نصاً إلى بصمته السداسية SHA-256.
 *
 * The token is looked up by digest, so the plaintext never touches a query —
 * and the unique index on `token_hash` (migration 314) turns a repeated digest
 * into replay protection rather than a second live token.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * يولّد رمز استعادة عشوائياً (32 بايت) وبصمته المخزَّنة.
 *
 * 32 bytes from the CSPRNG is the reset-token size the security review settled
 * on; base64url keeps the link free of characters that need escaping.
 */
function mintResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

/**
 * يحدّد معرّف الحساب الذي يطابق المعرّف المكتوب داخل شركة المضيف فقط، أو null عند اللبس.
 *
 * Same contract as `findAccountEmail` in `signInWithIdentifier.ts`: a lookup
 * returning more than one row resolves to nothing, because picking one would
 * mint a reset link for an account the person may not own.
 */
async function resolveAccountId(
  db: SupabaseClient<Database>,
  identifier: string,
): Promise<string | null> {
  const value = identifier.trim();
  const kind = classifyIdentifier(identifier);

  if (kind === "email" || kind === "username") {
    // `username` and `email` are citext, so the match is case-insensitive in
    // the database rather than by lowercasing here.
    const column = kind === "email" ? "email" : "username";
    const { data, error } = await db.from("profiles").select("id").eq(column, value).limit(2);
    if (error) throw new Error(`profiles lookup failed: ${error.message}`);
    return data?.length === 1 ? data[0].id : null;
  }

  const digits = nationalPhoneDigits(value);
  if (!digits) return null;

  // `phone` is free text, so the suffix comparison happens in SQL over a
  // digits-only projection (`find_profiles_by_phone_digits`).
  const { data, error } = await db.rpc("find_profiles_by_phone_digits", { _digits: digits });
  if (error) throw new Error(`find_profiles_by_phone_digits failed: ${error.message}`);
  const matches = (data ?? []) as Array<{ id: string }>;
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * يقرأ ملف الحساب المرشَّح للاستعادة، أو null إن كان معطَّلاً أو بلا بريد.
 *
 * A deactivated account cannot sign in, and an account without an email has no
 * channel the reset link could travel on — minting a token for either would
 * promise a recovery that cannot work. The caller answers identically either
 * way, so this filter is not an enumeration oracle.
 */
async function loadResetProfile(
  db: SupabaseClient<Database>,
  accountId: string,
): Promise<ResetAccount | null> {
  const { data, error } = await db
    .from("profiles")
    .select("id, email, display_name, username, is_active, preferred_locale")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(`profiles lookup failed: ${error.message}`);
  if (!data || !data.is_active || !data.email) return null;
  return {
    id: data.id,
    email: data.email,
    displayName: data.display_name ?? data.username ?? "",
    locale: data.preferred_locale,
  };
}

/**
 * يبني رابط الاستعادة على مضيف الطلب نفسه.
 *
 * The link host is the request's own host on purpose: a company's users must
 * land back on that company's address, and a shared platform URL would put one
 * company's reset link on another company's branding. `companyOrigin` also
 * keeps the scheme right on a local host, which has no TLS.
 */
function resetLink(host: string, token: string): string {
  return `${companyOrigin(host)}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * يرسل رسالة الاستعادة عبر مسار الإشعارات القائم (صف إشعار ثم مهمة `notification.dispatch`).
 *
 * `bypassTemplateChannel` for the same reason as credential mail: a recovery
 * link is account provisioning, not a notification preference, and a template
 * switched to WhatsApp-only must not leave an account unrecoverable. The raw
 * token lives only in the message body — the row's `payload` carries ids.
 */
async function sendResetEmail(
  company: RequestCompany,
  account: ResetAccount,
  token: string,
): Promise<void> {
  const resetUrl = resetLink(company.host, token);
  const copy = await loadTemplateCopy(RESET_TEMPLATE_CODE, account.locale, {
    display_name: account.displayName,
    reset_url: resetUrl,
    expires_minutes: String(RESET_TOKEN_TTL_MINUTES),
  });
  const message = passwordResetTemplate({
    locale: account.locale,
    displayName: account.displayName,
    resetUrl,
    expiresMinutes: RESET_TOKEN_TTL_MINUTES,
    intro: copy.body,
    subject: copy.subject,
  });
  await enqueueNotification({
    // `user_credentials` is the closest member of the closed
    // `notification_types` enum, and it also opts this row out of the
    // tenant-record address expansion in the email channel. A dedicated
    // `password_reset` member needs an enum migration (manager-owned).
    type: "user_credentials",
    bypassTemplateChannel: true,
    channel: "email",
    audience: "system",
    companyId: company.id,
    locale: account.locale,
    subject: message.subject,
    body: message.html,
    recipientAddress: account.email,
    // `notifications.template_code` is a foreign key to
    // `notification_templates(company_id, code)`, and `channel` is NOT NULL on
    // that table — so a non-null channel is proof that the company's template
    // row exists. Until it does, the row stays untagged rather than being
    // refused whole; the wording still comes from the template when it is
    // there, and from the code copy when it is not.
    templateCode: copy.channel ? RESET_TEMPLATE_CODE : null,
    payload: { user_id: account.id },
  });
}

/**
 * يعلن الرموز المفتوحة الأخرى لهذا المستخدم في هذه الشركة منتهية.
 *
 * Open reset links die the moment a password actually changes, whichever flow
 * changed it: a link mailed before a forced first-sign-in change must not still
 * be able to set the password afterwards.
 */
async function revokeOpenTokens(
  db: SupabaseClient<Database>,
  companyId: string,
  userId: string,
  keepTokenId: string | null,
): Promise<void> {
  const revokedAt = new Date().toISOString();
  let query = db
    .from("password_reset_tokens")
    .update({ expires_at: revokedAt })
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .is("used_at", null)
    .gt("expires_at", revokedAt);
  if (keepTokenId) query = query.neq("id", keepTokenId);
  const { error } = await query;
  if (error) throw new Error(`password_reset_tokens revoke failed: ${error.message}`);
}

/**
 * يزيل وسم «يجب تغيير كلمة المرور» عن ملف المستخدم.
 *
 * Runs as `company_service`, where `auth.uid()` is null — the only path
 * migration 316's self-update guard leaves open, so a signed-in user can never
 * clear the flag themselves. Returns the tenant link so callers can route the
 * person to the right sign-in page afterwards.
 */
async function clearMustChangePassword(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<{ tenantId: string | null }> {
  const { data, error } = await db
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", userId)
    .select("tenant_id")
    .single();
  if (error) throw new Error(`profiles flag clear failed: ${error.message}`);
  return { tenantId: data.tenant_id };
}

/**
 * يتحقق مما إذا بلغ الحساب الحد الأقصى لطلبات الاستعادة داخل النافذة الزمنية.
 *
 * Counts tokens minted in the last 15 minutes for this user in this company
 * so repeated requests cannot flood the account's inbox.
 */
async function hasReachedResetCap(
  db: SupabaseClient<Database>,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - RESET_CAP_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error } = await db
    .from("password_reset_tokens")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .gt("created_at", windowStart);
  if (error) throw new Error(`password_reset_tokens count failed: ${error.message}`);
  return (count ?? 0) >= RESET_CAP_MAX_TOKENS;
}

/**
 * يتحقق من انتماء المستخدم المسجَّل دخوله إلى شركة المضيف ويعيد وسم التغيير الإجباري ومعرّفاته.
 *
 * Reads `profiles.company_id` through the RLS-scoped `companyClient`; a bearer
 * token belonging to another company returns no row and is refused with the
 * same generic `Unauthorized` error as `requireSupabaseAuth`.
 */
async function assertProfileInCompany(
  db: SupabaseClient<Database>,
  companyId: string,
  userId: string,
): Promise<CallerProfile> {
  const { data, error } = await db
    .from("profiles")
    .select("company_id, must_change_password, email, username")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`profiles lookup failed: ${error.message}`);
  if (!data || data.company_id !== companyId) {
    throw new Error("Unauthorized");
  }
  return {
    mustChangePassword: data.must_change_password,
    email: data.email,
    username: data.username,
  };
}

/**
 * ينشئ عميل Supabase مجهولاً للتحقق من كلمة المرور الحالية عبر GoTrue.
 *
 * Mirrors `anonClient` in `signInWithIdentifier.ts`: `autoRefreshToken: false`
 * prevents a background refresh ticker from outliving this one-off check and
 * rotating the caller's refresh token family.
 */
function anonClient() {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SELF_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) throw new Error("Supabase URL or anon key is not configured.");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * يتحقق من كلمة المرور الحالية للحساب عبر بوابة كلمة المرور في GoTrue.
 *
 * Tries the verified JWT's email first, then the synthetic address
 * (`syntheticAuthEmail(userId)`) and legacy fallbacks, signing out the
 * temporary verification session immediately on match.
 */
async function verifyCurrentPassword(
  userId: string,
  profile: CallerProfile,
  currentPassword: string,
  claimsEmail?: string,
): Promise<boolean> {
  const candidates = [
    claimsEmail,
    syntheticAuthEmail(userId),
    profile.email,
    profile.username ? loginIdentifierToEmail(profile.username) : null,
  ].filter((email, index, all): email is string => Boolean(email) && all.indexOf(email) === index);

  const loginClient = anonClient();
  for (const email of candidates) {
    const attempt = await loginClient.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (!attempt.error && attempt.data.session) {
      await loginClient.auth.signOut({ scope: "local" });
      return true;
    }
  }
  return false;
}

/**
 * يطلب رابط إعادة تعيين كلمة المرور لمعرّف على مضيف الشركة، ويرد بالرد العام دائماً.
 *
 * Unauthenticated and attacker-reachable, so two invariants hold no matter what
 * happens inside. First, the answer is the same generic success whether or not
 * an account matched — the form can never be used as an account-existence
 * oracle. Second, every request is recorded through `recordFailedLoginAttempt`,
 * the same throttled counter ladder sign-in failures use (1 / 5 / 25 per
 * identifier and IP window), so a spray cannot grow the audit trail without
 * bound. `INVALID_CREDENTIALS` is the closest code in `loginAudit`'s closed
 * union; a dedicated `PASSWORD_RESET_REQUESTED` code would read better in the
 * audit log and needs the shared file (outside this slice).
 *
 * The mint-and-send block is therefore allowed to fail loudly *only into the
 * log*: a thrown error on the account path would itself reveal that an account
 * exists.
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseServerInput(requestSchema, data))
  .handler(async ({ data }) => {
    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const accountId = await resolveAccountId(db, data.identifier);
    const account = accountId ? await loadResetProfile(db, accountId) : null;

    await recordFailedLoginAttempt({
      identifier: data.identifier,
      accountId,
      errorCode: "INVALID_CREDENTIALS",
    });

    if (!account) return { ok: true as const };

    try {
      if (await hasReachedResetCap(db, company.id, account.id)) {
        return { ok: true as const };
      }
      const { token, tokenHash } = mintResetToken();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000).toISOString();
      const insert = await db
        .from("password_reset_tokens")
        .insert({
          company_id: company.id,
          user_id: account.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
        })
        .select("id")
        .single();
      if (insert.error) {
        throw new Error(`password_reset_tokens insert failed: ${insert.error.message}`);
      }
      await sendResetEmail(company, account, token);
    } catch (error) {
      console.error("password reset request failed:", error);
    }

    return { ok: true as const };
  });

/**
 * يستهلك رمز استعادة ذرياً ثم يضع كلمة مرور جديدة: رفض موحّد لكل رمز غير صالح.
 *
 * Consumes the token atomically (`used_at is null` and `expires_at > now()`)
 * before touching the password, so two concurrent requests with the same token
 * cannot both pass and set a password. Runs under the host company's client, so
 * a token minted by company A is invisible on company B's host (RLS) and fails
 * identically with `INVALID_TOKEN`.
 */
export const confirmPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseServerInput(confirmSchema, data))
  .handler(async ({ data }) => {
    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const now = new Date().toISOString();
    const consumed = await db
      .from("password_reset_tokens")
      .update({ used_at: now })
      .eq("company_id", company.id)
      .eq("token_hash", sha256Hex(data.token))
      .is("used_at", null)
      .gt("expires_at", now)
      .select("id, user_id")
      .maybeSingle();
    if (consumed.error) {
      throw new Error(`password_reset_tokens consume failed: ${consumed.error.message}`);
    }
    if (!consumed.data) return { ok: false as const, error: "INVALID_TOKEN" };

    const updated = await updateAuthUserById(consumed.data.user_id, { password: data.password });
    if (updated.error) {
      throw new Error(
        `password update failed: ${authErrorMessage(updated.error, "auth service error")}`,
      );
    }

    const signedOut = await signOutAuthUser(consumed.data.user_id);
    if (signedOut.error) {
      throw new Error(`session revoke failed: ${signedOut.error.message}`);
    }

    const { tenantId } = await clearMustChangePassword(db, consumed.data.user_id);
    await revokeOpenTokens(db, company.id, consumed.data.user_id, consumed.data.id);

    // The platform audit log records the change like any other user mutation
    // (`user.create`, `user.delete`), so a company can see that a password was
    // reset on one of its accounts and when.
    await db.rpc("write_audit", {
      p_action: "user.password_reset",
      p_entity_type: "user",
      p_entity_id: consumed.data.user_id,
      p_before: null,
      p_after: { via: "email" },
      p_result: "success",
      p_error_code: null,
    });

    return { ok: true as const, portalAccount: tenantId !== null };
  });

/**
 * يغيّر كلمة مرور المستخدم المسجَّل دخوله ويزيل وسم التغيير الإجباري ويلغي كل الجلسات.
 *
 * When `must_change_password` is true (first-sign-in change, FR-032), the
 * caller just signed in with the temporary password and no current password is
 * requested. Otherwise the caller must prove possession of the current
 * password via GoTrue before any write; wrong attempts join the throttled
 * `recordFailedLoginAttempt` ladder.
 */
export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(changeSchema, data))
  .handler(async ({ data, context }) => {
    const company = requireRequestCompany();
    const db = companyClient(company.id);

    const profile = await assertProfileInCompany(db, company.id, context.userId);
    if (!profile.mustChangePassword) {
      const claimsEmail = (context as { claims?: { email?: string } }).claims?.email;
      const valid =
        Boolean(data.currentPassword) &&
        (await verifyCurrentPassword(context.userId, profile, data.currentPassword!, claimsEmail));
      if (!valid) {
        await recordFailedLoginAttempt({
          identifier: profile.username ?? profile.email ?? context.userId,
          accountId: context.userId,
          errorCode: "INVALID_CREDENTIALS",
        });
        return { ok: false as const, error: "INVALID_CREDENTIALS" };
      }
    }

    const updated = await updateAuthUserById(context.userId, { password: data.password });
    if (updated.error) {
      throw new Error(
        `password update failed: ${authErrorMessage(updated.error, "auth service error")}`,
      );
    }

    const signedOut = await signOutAuthUser(context.userId);
    if (signedOut.error) {
      throw new Error(`session revoke failed: ${signedOut.error.message}`);
    }

    await clearMustChangePassword(db, context.userId);
    await revokeOpenTokens(db, company.id, context.userId, null);

    // A password change, forced or not, is recorded where a company looks for it.
    await db.rpc("write_audit", {
      p_action: "user.password_change",
      p_entity_type: "user",
      p_entity_id: context.userId,
      p_before: null,
      p_after: { forced: profile.mustChangePassword },
      p_result: "success",
      p_error_code: null,
    });

    return { ok: true as const };
  });
