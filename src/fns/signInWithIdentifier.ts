import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { Database } from "@/integrations/supabase/database.types";
import {
  classifyIdentifier,
  loginIdentifierToEmail,
  nationalPhoneDigits,
} from "@/auth/loginIdentity";
import { recordFailedLoginAttempt, recordLoginAttempt } from "@/fns/loginAudit";

/**
 * Signing in with a username, an email address, or a mobile number.
 *
 * GoTrue only authenticates an email, so something has to map the identifier
 * onto one. That mapping must happen on the server: `profiles` is behind RLS
 * and unreadable to an anonymous visitor, and exposing it would be worse than
 * unhelpful.
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

/** نتيجة تحويل المعرّف: معرّف الحساب وبريده وحالة تفعيله. */
type ResolvedAccount = { id: string; email: string; isActive: boolean };

/**
 * يحوّل المعرّف المكتوب إلى بريد الحساب وحالته، أو null إذا تعذّر التحديد.
 *
 * `is_active` travels with the email rather than being fetched later so the
 * deactivation decision cannot race a second round-trip, and so an ambiguous
 * match still resolves to nothing at all.
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
    const { data } = await db
      .from("profiles")
      .select("id, email, is_active")
      .eq(column, value)
      .limit(2);
    if (data?.length !== 1) return null;
    return data[0].email
      ? { id: data[0].id, email: data[0].email, isActive: data[0].is_active }
      : null;
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
  if (matches.length !== 1) return null;
  if (!matches[0].email) return null;

  // The phone RPC projects only `id` and `email`; the account flag needs its
  // own read, keyed by the id the RPC already proved unambiguous.
  const { data: profile } = await db
    .from("profiles")
    .select("is_active")
    .eq("id", matches[0].id)
    .single();
  if (!profile) return null;
  return { id: matches[0].id, email: matches[0].email, isActive: profile.is_active };
}

export const signInWithIdentifier = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data }) => {
    const company = requireRequestCompany();
    const db = companyClient(company.id);

    /*
     * A failed lookup falls through to the legacy mapping rather than returning
     * early, for two reasons. It keeps every login that works today working —
     * accounts with no real address authenticate as `<username>@users.local`.
     * And it means an unknown identifier still costs a real password check, so
     * "no such account" and "wrong password" take the same path and are not
     * distinguishable from the outside.
     */
    const resolved = await findAccountEmail(db, data.identifier);
    const email = resolved?.email ?? loginIdentifierToEmail(data.identifier);

    const { data: session, error } = await anonClient().auth.signInWithPassword({
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
    if (error && (error as { code?: string }).code === "user_banned") {
      await recordFailedLoginAttempt({
        identifier: data.identifier,
        accountId: resolved?.id ?? null,
        errorCode: "ACCOUNT_DEACTIVATED",
      });
      return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
    }

    if (error || !session.session) {
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

    // Checked only after the password verifies. Returning this on a failed password
    // would turn the form into an oracle for which accounts exist and are disabled.
    if (resolved && !resolved.isActive) {
      // The password verified, so a session exists — but the account is refused,
      // and attributing the row to it would read as a successful sign-in in the
      // actor column. Recorded as a service-role failure instead.
      await recordLoginAttempt({
        identifier: data.identifier,
        accountId: resolved.id,
        actorId: null,
        result: "failure",
        errorCode: "ACCOUNT_DEACTIVATED",
      });
      return { ok: false as const, error: "ACCOUNT_DEACTIVATED" };
    }

    // GoTrue has just authenticated this person, so its own answer identifies
    // them even when the profiles lookup did not. Review finding on PR #206:
    // taking the id only from `resolved` recorded the legacy `@users.local`
    // fallback — and any login whose profiles read failed — as a successful
    // sign-in by "system" with no account attached, which is precisely the
    // login nobody could then trace.
    const signedInUserId = session.session.user?.id ?? resolved?.id ?? null;

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
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
    };
  });
