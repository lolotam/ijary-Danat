import { createClient } from "@supabase/supabase-js";
import { getRequest } from "@tanstack/react-start/server";

import type { Database } from "@/integrations/supabase/database.types";
import { clientAddress } from "@/lib/clientAddress";

/**
 * تسجيل محاولات الدخول في سجل التدقيق.
 *
 * Reconstructing a single customer's failed login used to mean reading three
 * container logs that rotate away, while the Audit screen showed nothing at
 * all. Successful sign-ins still write one `auth.login` row. The two
 * attacker-reachable failures go through `record_failed_login`, which writes
 * 1 / 5 / 25 per identifier — and, once an IP exceeds 25 in the window, only
 * on the IP-scoped ×5 ladder — so a spray cannot grow `audit_logs` without
 * bound.
 *
 * **The password never appears here.** The identifier as the person typed it
 * does — that is the whole point, since the usual cause is a mistyped username
 * or a mobile number stored in a different format — but the credential itself
 * is not passed into this module at all, so it cannot leak into `after`.
 *
 * **Why a purpose-built client rather than `supabaseAdmin`.** `write_audit`
 * derives `ip`, `user_agent`, `path` and `correlation_id` from PostgREST's
 * `request.headers`, which are the headers *our* Node process sent to
 * PostgREST — not the browser's. `supabaseAdmin` sends none of them, so those
 * columns would be null on every login row. Forwarding the visitor's headers
 * onto the PostgREST call populates them with no schema change.
 */

/** الإجراء المسجَّل لكل محاولة دخول، ناجحة كانت أو فاشلة. */
export const LOGIN_AUDIT_ACTION = "auth.login";

/** رموز الفشل المسجَّلة، وهي نفس الرموز التي تعود إلى المتصفّح. */
export type LoginAuditErrorCode = "INVALID_CREDENTIALS" | "ACCOUNT_DEACTIVATED";

export interface LoginAuditInput {
  /** المعرّف كما كتبه المستخدم: اسم مستخدم أو بريد أو رقم هاتف. */
  identifier: string;
  /** معرّف الحساب عندما ينجح التحديد بلا لبس، وإلا null. */
  accountId: string | null;
  /**
   * معرّف الحساب الذي نجح دخوله، أو null لأي محاولة فاشلة.
   *
   * Passed to `write_audit` as `p_actor_id`, which migration 209 honours only
   * for a `service_role` caller — so the row names the person who signed in
   * without this process ever holding their session. An earlier version sent
   * the visitor's JWT instead; that made the caller `authenticated`, which
   * migration 209 no longer trusts with request metadata, and it put a user's
   * session on a server-side client, the shape that once got whole session
   * families revoked as refresh-token reuse.
   */
  actorId: string | null;
  result: "success" | "failure";
  errorCode: LoginAuditErrorCode | null;
}

/** الترويسات المُعاد إرسالها إلى PostgREST ليقرأها write_audit. */
type ForwardedHeaders = Record<string, string>;

/**
 * ينسخ ترويسات الزائر التي يقرأها write_audit من الطلب الجاري.
 *
 * **The address and path must travel under names no proxy owns.** There are
 * three hops between this process and PostgREST — the app container resolves
 * `supabase.danat-future.com` to Cloudflare, which reaches Traefik, which
 * reaches Kong — and each rewrites the `x-forwarded-*` family, because that is
 * what those headers are for. Measured from inside the app container: sending
 * `x-forwarded-for: 203.0.113.55` stored a Cloudflare edge address instead, and
 * `x-forwarded-uri` was stripped to an empty string.
 *
 * The same probe showed that headers outside that family survive the chain
 * untouched — `x-request-id` and `user-agent` both arrived intact — so
 * migration 207 teaches `write_audit` to prefer `x-danat-client-ip` and
 * `x-danat-request-path`, which is what this sends.
 *
 * Returns an empty set outside a request context (a job, a test) rather than
 * throwing — an audit row with null request metadata beats no audit row.
 */
function forwardedRequestHeaders(): ForwardedHeaders {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    return {};
  }

  const headers: ForwardedHeaders = {};

  const address = clientAddress(request);
  if (address) headers["x-danat-client-ip"] = address;

  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers["user-agent"] = userAgent;

  const requestId = request.headers.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;

  // `path` and `method` have no inbound equivalent to copy — they describe the
  // login call itself. `x-http-method` is left as-is: it survived the proxies
  // intact in the same probe, being no part of the rewritten family.
  headers["x-danat-request-path"] = new URL(request.url).pathname;
  headers["x-http-method"] = request.method;

  return headers;
}

/**
 * يبني عميلاً موجّهاً لكتابة صف التدقيق وحده، بصلاحية service_role دائماً.
 *
 * Always service_role, never the visitor's own token. Migration 209 honours
 * `x-danat-client-ip`, `x-danat-request-path` and `p_actor_id` only for that
 * role — because `write_audit` is granted to `authenticated` and PostgREST
 * exposes it, so a signed-in user could otherwise attach a false address, path
 * or actor to an audit row.
 *
 * `autoRefreshToken: false` remains set for the same reason every other client
 * in this codebase sets it: auth-js starts its refresh ticker unconditionally
 * off-browser, and a ticker outliving a per-request client is what previously
 * revoked browser session families as suspected token reuse.
 */
function auditClient(headers: ForwardedHeaders) {
  const url = process.env.SUPABASE_URL || process.env.SELF_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SELF_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  return createClient<Database>(url, serviceRoleKey, {
    global: { headers },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * يكتب صف تدقيق واحداً لمحاولة دخول، ولا يفشل أبداً بشكل يمنع الدخول.
 *
 * Swallowing the error is deliberate. An audit outage must not become an
 * outage of the login form itself; the console line is what surfaces it.
 */
export async function recordLoginAttempt(input: LoginAuditInput): Promise<void> {
  try {
    const headers = forwardedRequestHeaders();
    const client = auditClient(headers);
    if (!client) return;

    const { error } = await client.rpc("write_audit", {
      p_action: LOGIN_AUDIT_ACTION,
      p_entity_type: "user",
      p_entity_id: input.accountId,
      p_actor_id: input.actorId,
      p_before: null,
      // The identifier is duplicated here rather than only implied by
      // `entity_id`, because the failures worth investigating are exactly the
      // ones where no account resolved and `entity_id` is null.
      p_after: { identifier: input.identifier },
      p_result: input.result,
      p_error_code: input.errorCode,
    });
    if (error) console.error("Login audit write failed", error.message);
  } catch (error) {
    console.error("Login audit write failed", error);
  }
}

/**
 * يسجّل محاولة دخول فاشلة عبر RPC يقيّد ما يُكتب في سجل التدقيق.
 *
 * `record_failed_login` counts per (identifier, client IP, clock-aligned
 * 15-minute window) and per client IP alone. Identifier-scoped writes are
 * 1, 5 and 25 only — the identifier counter does not run once the IP exceeds
 * 25, so a per-identifier 125 never happens. After that the IP-scoped ×5
 * ladder (125, 625, …) carries the magnitude. The two attacker-reachable
 * failures in `signInWithIdentifier` used to call `recordLoginAttempt`
 * unbounded, which grew the append-only `audit_logs` table and buried the
 * forensic events it exists to hold.
 *
 * Same swallow-and-log contract as `recordLoginAttempt`: a failure to record
 * must never break a login. The custom `x-danat-client-ip` header is what
 * the RPC reads to key the throttle, so this goes through the same client.
 */
export async function recordFailedLoginAttempt(input: {
  identifier: string;
  accountId: string | null;
  errorCode: LoginAuditErrorCode;
}): Promise<void> {
  try {
    const headers = forwardedRequestHeaders();
    const client = auditClient(headers);
    if (!client) return;

    const { error } = await client.rpc("record_failed_login", {
      p_identifier: input.identifier,
      p_account_id: input.accountId,
      p_error_code: input.errorCode,
    });
    if (error) console.error("Login audit write failed", error.message);
  } catch (error) {
    console.error("Login audit write failed", error);
  }
}
