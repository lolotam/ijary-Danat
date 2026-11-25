/**
 * Google OAuth wiring for the Gmail inbox connection.
 *
 * Server-only. `GMAIL_CLIENT_SECRET` and the state-signing secret must never be
 * read from browser-reachable code, and none of these may be given a `VITE_`
 * prefix — anything so prefixed is compiled into the client bundle.
 */

/**
 * Read the mailbox, send as it, and modify it.
 *
 * `gmail.modify` was added on 2026-08-01 so that deleting a message in the app
 * moves it to Trash in Gmail. Without it, a delete removed only the local row
 * and the next sync tick pulled the same message straight back in.
 *
 * Trash, not permanent delete: `modify` covers `messages/{id}/trash` and the
 * result is recoverable for 30 days. Permanent deletion needs the full
 * `https://mail.google.com/` scope, which is a far larger grant for a worse
 * failure mode.
 *
 * A refresh token does not gain scopes retroactively, so any connection made
 * before this date can read and send but not trash, and must be disconnected
 * and reconnected once. `grantCanModify` in lib/gmailClient.server.ts detects
 * that case and the delete path says so instead of failing opaquely — the same
 * treatment `gmail.send` got when it was added.
 */
export const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** Where the settings page lives, for the post-callback redirect. */
export const INTEGRATIONS_PATH = "/admin/settings/integrations";

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Signs the `state` parameter. Reuses CRON_SECRET rather than adding a knob. */
  stateSecret: string;
}

export function readGmailOAuthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;
  // The state signature only needs to be unguessable and server-held; CRON_SECRET
  // already satisfies both and is present on every deployment, so this avoids a
  // second secret that someone has to remember to set.
  const stateSecret = process.env.CRON_SECRET;
  if (!clientId || !clientSecret || !redirectUri || !stateSecret) return null;
  return { clientId, clientSecret, redirectUri, stateSecret };
}

/**
 * Builds the consent URL.
 *
 * `access_type=offline` together with `prompt=consent` is what makes Google
 * return a refresh token. Without both, a mailbox that has consented before
 * comes back with an access token only, and the sync job has nothing durable to
 * store — a failure that appears days later when the access token expires.
 */
export function buildConsentUrl(config: GmailOAuthConfig, state: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}
