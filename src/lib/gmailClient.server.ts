import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

/**
 * Shared Gmail credential handling.
 *
 * The sync job owned this privately until sending and attachment download
 * needed the same access token. Server-only: it reads `refresh_token`, which is
 * deliberately outside the `authenticated` column grant
 * (db/migrations/53_gmail_connections.sql) and must never reach the browser.
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** The scope a grant needs before it may send. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** The scope a grant needs before it may trash a message. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Gmail's user id; "me" is the account the token belongs to. */
  address: string;
}

export interface GmailGrant {
  credentials: GmailCredentials;
  connectionId: string | null;
  /** Space-separated scopes as Google returned them, when a connection exists. */
  scope: string | null;
  emailAddress: string | null;
}

/**
 * Resolves the credential to act with.
 *
 * Prefers the stored `gmail_connections` grant and falls back to
 * GMAIL_REFRESH_TOKEN. That ordering matters for send: the env token predates
 * the OAuth flow and was minted read-only, so a deployment that sets it will
 * appear connected and still refuse to send. It is intentionally unset in
 * production for exactly that reason.
 */
export async function readGmailGrant(): Promise<GmailGrant | null> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const { data: connection } = await supabaseAdmin
    .from("gmail_connections")
    .select("id, refresh_token, email_address, scope")
    .limit(1)
    .maybeSingle();

  const refreshToken = connection?.refresh_token || process.env.GMAIL_REFRESH_TOKEN;
  if (!refreshToken) return null;

  return {
    connectionId: connection?.id ?? null,
    scope: connection?.scope ?? null,
    emailAddress: connection?.email_address ?? null,
    credentials: {
      clientId,
      clientSecret,
      refreshToken,
      address: process.env.GMAIL_SYNC_ADDRESS || "me",
    },
  };
}

/** True when the stored grant may send. A null scope is treated as unknown. */
export function grantCanSend(scope: string | null): boolean {
  return Boolean(scope?.split(/\s+/).includes(GMAIL_SEND_SCOPE));
}

/** True when the stored grant may modify mail. A null scope is treated as unknown. */
export function grantCanModify(scope: string | null): boolean {
  return Boolean(scope?.split(/\s+/).includes(GMAIL_MODIFY_SCOPE));
}

/**
 * Exchanges the long-lived refresh token for an access token (~1h lifetime).
 */
export async function getGmailAccessToken(credentials: GmailCredentials): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail token refresh failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Gmail token response had no access_token.");
  return json.access_token;
}

/**
 * Turns Google's scope failures into an instruction the admin can act on.
 *
 * A raw "403 insufficient authentication scopes" sends someone to the logs.
 * The real fix is always the same and is a single click, so say that instead.
 *
 * `feature` names the capability that was refused ("sending", "deleting",
 * "downloading attachments", ...). It defaults to "sending" so the original
 * call site in gmailSend.ts is unchanged. Every other caller must pass its own
 * word: a stale `scope` column (revoked at the Google Account level without an
 * in-app disconnect) lets a caller's own pre-flight check pass and only Gmail's
 * 403 catches it, so the wording has to be right at the point Gmail's response
 * is actually read, not just at the pre-flight check upstream of it.
 */
export function describeGmailApiError(status: number, body: string, feature = "sending"): string {
  if (status === 403 && /insufficient|scope/i.test(body)) {
    return `Gmail refused this because the connection was granted before ${feature} was enabled. Open Settings → Integrations, click Disconnect, then Connect Gmail again to re-authorise.`;
  }
  if (status === 401) {
    return "The Gmail connection has expired. Reconnect it in Settings → Integrations.";
  }
  return `Gmail API error (${status}): ${body}`;
}
