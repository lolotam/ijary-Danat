import { createServerFn } from "@tanstack/react-start";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany, requireRequestCompany } from "@/company/requestCompany.server";
import type { Database } from "@/integrations/supabase/database.types";
import {
  classifyIdentifier,
  loginIdentifierToEmail,
  nationalPhoneDigits,
  syntheticAuthEmail,
} from "@/auth/loginIdentity";
import { recordFailedLoginAttempt, recordLoginAttempt } from "@/fns/loginAudit";

/**
 * Signing in with a username, an email address, or a mobile number — and the
 * one company-context read the browser needs to finish a sign-in.
 *
 * GoTrue only authenticates an email, so something has to map the identifier
 * onto one. That mapping must happen on the server: `profiles` is behind RLS
 * and unreadable to an anonymous visitor, and exposing it would be worse than
 * unhelpful. The lookup runs inside the host's company only, so the same
 * identifier in two companies resolves to the host company's own account.
 *
 * **Why this takes the password.** The obvious shape — an RPC that turns an
 * identifier into an email — is an account-enumeration and PII leak: anyone
 * could submit a username and be handed that person's email address, no
 * credential required. Taking both means a lookup never produces an answer on
 * its own. The whole exchange either succeeds as a login or fails as one.
 *
 * The browser receives the same session tokens GoTrue would have given it
 * directly, and installs them with `supabase.auth.setSession`.
 */

const schema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(128),
});

/**
 * A plain anon-key client. Deliberately *not* `supabaseAdmin`: signing in is a
 * normal password grant, and doing it with a service-role key would bypass the
 * protections GoTrue applies to real logins.
 *
 * **`autoRefreshToken: false` is load-bearing, not tidiness.** It defaults to
 * true, and auth-js starts the ticker unconditionally off-browser — its own
 * comment is "in non-browser environments the refresh token ticker runs
 * always". This client is created per login and thrown away, so a ticker would
 * outlive it inside the server process, holding that user's session forever.
 *
 * The browser holds the same session (the caller installs it with
 * `setSession`), and GoTrue *rotates* refresh tokens — so the second holder to
 * refresh presents a consumed token, GoTrue reports `refresh_token_already_used`
 * / "possible abuse attempt", and revokes the whole session family. The user is
 * silently signed out mid-session and every permission check fails, which reads
 * as "no permission to access the dashboard" rather than as a lost login.
 * Signing in again only added another ticker, so it compounded.
 *
 * `client.ts`, `client.server.ts` and `auth-middleware.ts` all disable it; this
 * client was the one that did not.
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

/** نتيجة تحويل المعرّف: معرّف الحساب وبريده. */
type ResolvedAccount = { id: string; email: string };

/**
 * يحوّل المعرّف المكتوب إلى بريد الحساب، أو null إذا تعذّر التحديد.
 *
 * Whether the account may sign in here (company, `is_active`) is decided after
 * the password verifies, from the id GoTrue returns — see `companyMember`.
 *
 * Ambiguity is refused rather than resolved. `profiles.username` is unique, but
 * `email` and `phone` are not — two tenants can share a household number. If a
 * lookup returned more than one row, picking the first would mean checking a
 * password against an account the person may not own, and a correct password
 * for the wrong row would log them into someone else's portal.
 */
async function findAccountEmail(
  db: SupabaseClient<Database>,
  identifier: string,
): Promise<ResolvedAccount | null> {
  const kind = classifyIdentifier(identifier);
  const value = identifier.trim();

  if (kind === "email" || kind === "username") {
    // `username` and `email` are both citext, so this is case-insensitive in
    // the database rather than by lowercasing here.
    const column = kind === "email" ? "email" : "username";
    const { data } = await db.from("profiles").select("id, email").eq(column, value).limit(2);
    if (data?.length !== 1) return null;
    return data[0].email ? { id: data[0].id, email: data[0].email } : null;
  }

  const digits = nationalPhoneDigits(value);
  if (!digits) return null;

  // `phone` is free text, so the suffix comparison happens in SQL over a
  // digits-only projection — an equality match would miss every number stored
  // in a different format from the one typed.
  const { data } = await db.rpc("find_profiles_by_phone_digits", {
    _digits: digits,
  });
  const matches = (data ?? []) as Array<{ id: string; email: string | null }>;
  if (matches.length !== 1 || !matches[0].email) return null;
  return { id: matches[0].id, email: matches[0].email };
}

/**
 * يقرأ ملف المستخدم الذي صادق عليه GoTrue داخل شركة الطلب فقط، أو null إن لم يكن من موظفيها أو مستأجريها.
 *
 * GoTrue accounts span every company, so a correct password proves who the
 * person is, not that they belong here. `db` is the request company's client,
 * so RLS hides every other company's profile and "not found" is the answer for
 * an account of another company.
 */
async function companyMember(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<{ id: string; isActive: boolean } | null> {
  const { data } = await db.from("profiles").select("id, is_active").eq("id", userId).maybeSingle();
  return data ? { id: data.id, isActive: data.is_active } : null;
}

export const signInWithIdentifier = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data }) => {
    const company = requireRequestCompany();
    const db = companyClient(company.id);

    /*
     * The password is tried against up to three addresses for the one account
     * the company-scoped lookup resolved. The synthetic address goes first,
     * because it is the only one guaranteed to belong to *this* account;
     * `profiles.email` and the legacy `<username>@users.local` mapping remain
     * as fallbacks for accounts created before synthetic auth emails
     * (research.md R3): the synthetic form is what every admin write now
     * converges on, but old accounts keep whatever address they were created
     * with until they are next edited.
     *
     * Order is load-bearing when one real address sits on two companies'
     * profiles: GoTrue holds a single account for that address, and it is not
     * necessarily the host company's. A fallback-first order would grant that
     * sibling's session and refuse a correct password here. Synthetic-first
     * always names the resolved account, so the shared address is only ever
     * reached after this account's own address has failed.
     *
     * An unknown identifier still costs a real password check (the last
     * candidate), so "no such account" and "wrong password" take the same path
     * and are not distinguishable from the outside.
     */
    const resolved = await findAccountEmail(db, data.identifier);
    const candidates = [
      ...(resolved ? [syntheticAuthEmail(resolved.id), resolved.email] : []),
      loginIdentifierToEmail(data.identifier),
    ].filter((email, index, all) => all.indexOf(email) === index);

    const loginClient = anonClient();
    let session: Session | null = null;
    for (const email of candidates) {
      const attempt = await loginClient.auth.signInWithPassword({
        email,
        password: data.password,
      });

      // GoTrue refuses a banned account before it checks the password, so this is the
      // only signal available once `banned_until` is set — without it a deactivated
      // user would be told their credentials were wrong.
      //
      // This does leak that the account exists and is disabled, to anyone, with any
      // password. That leak is GoTrue's, not ours: `POST /token` returns the same
      // `user_banned` to a direct caller whatever this function does. Mirroring it
      // here costs nothing an attacker cannot already obtain, and the alternative is
      // telling a real deactivated tenant their password is wrong.
      if (attempt.error && (attempt.error as { code?: string }).code === "user_banned") {
        await recordFailedLoginAttempt({
          identifier: data.identifier,
          accountId: resolved?.id ?? null,
          errorCode: "ACCOUNT_DEACTIVATED",
        });
        return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
      }

      if (!attempt.error && attempt.data.session) {
        session = attempt.data.session;
        break;
      }
    }

    if (!session) {
      // Deliberately one message for every failure. Saying which half was wrong
      // turns the login form into an account-existence oracle.
      //
      // The audit row is not bound by that rule: `audit_logs` is readable only
      // by staff with the audit permission, so recording which account was
      // aimed at reveals nothing to the person at the form.
      await recordFailedLoginAttempt({
        identifier: data.identifier,
        accountId: resolved?.id ?? null,
        errorCode: "INVALID_CREDENTIALS",
      });
      return { ok: false as const, error: "INVALID_CREDENTIALS" };
    }

    // GoTrue has just authenticated this person, so its own answer identifies
    // them even when the identifier lookup did not (the legacy `@users.local`
    // fallback). Review finding on PR #206: taking the id only from `resolved`
    // recorded those logins as "system" with no account attached.
    const member = await companyMember(db, session.user.id);

    // Same answer as a wrong password, so the form does not reveal that the
    // account exists in another company; the session GoTrue just issued is
    // revoked (local scope: only this session, not the person's others).
    if (!member) {
      await loginClient.auth.signOut({ scope: "local" });
      await recordFailedLoginAttempt({
        identifier: data.identifier,
        accountId: null,
        errorCode: "INVALID_CREDENTIALS",
      });
      return { ok: false as const, error: "INVALID_CREDENTIALS" };
    }

    // Checked only after the password verifies. Returning this on a failed password
    // would turn the form into an oracle for which accounts exist and are disabled.
    if (!member.isActive) {
      // The password verified, so a session exists — but the account is refused,
      // and attributing the row to it would read as a successful sign-in in the
      // actor column. Recorded as a service-role failure instead.
      await recordLoginAttempt({
        identifier: data.identifier,
        accountId: member.id,
        actorId: null,
        result: "failure",
        errorCode: "ACCOUNT_DEACTIVATED",
      });
      return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
    }

    const signedInUserId = member.id;

    await recordLoginAttempt({
      identifier: data.identifier,
      accountId: signedInUserId,
      // Only the success path names an actor. The audit write itself is
      // service_role, so the row can say who signed in without this process
      // ever holding their session.
      actorId: signedInUserId,
      result: "success",
      errorCode: null,
    });

    return {
      ok: true as const,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    };
  });

/**
 * يعيد معرّف شركة المضيف الحالي للمتصفح، أو null إذا لم يكن المضيف لشركة.
 *
 * The one company-context read the browser needs to finish a sign-in: after
 * any successful authentication the session's `profile.company_id` is compared
 * against this id (`AuthProvider`), and a mismatch counts as not signed in.
 * Unauthenticated on purpose — the host's identity is already public in its
 * own address and branding, and a sign-in form must be able to ask before
 * anyone has an account.
 */
export const getPublicRequestCompanyId = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | null> => getRequestCompany()?.id ?? null,
);
