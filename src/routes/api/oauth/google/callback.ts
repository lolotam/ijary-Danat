import { createFileRoute } from "@tanstack/react-router";

import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany } from "@/company/requestCompany.server";
import {
  GOOGLE_TOKEN_ENDPOINT,
  INTEGRATIONS_PATH,
  readGmailOAuthConfig,
} from "@/lib/gmailOAuthConfig";
import { verifyOAuthState } from "@/lib/oauthState";

/**
 * Google's redirect target for the Gmail connection.
 *
 * This route holds no session — Google sends the browser here directly, so
 * there is no Authorization header to check. The signed `state` is what
 * authenticates the request: without verifying it, anyone could send an admin's
 * browser here carrying their own authorization code and silently attach an
 * attacker-controlled mailbox to this deployment.
 *
 * Nothing secret is ever returned. Every exit is a redirect back to the
 * settings page carrying a coarse status flag — the refresh token is written
 * server-side and never appears in a response body, a URL, or a log line.
 */

function redirectTo(status: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${INTEGRATIONS_PATH}?gmail=${encodeURIComponent(status)}` },
  });
}

async function handleCallback(request: Request): Promise<Response> {
  const config = readGmailOAuthConfig();
  if (!config) return redirectTo("not-configured");

  const url = new URL(request.url);

  // The user pressed "Cancel" on Google's consent screen, or Google refused.
  if (url.searchParams.get("error")) return redirectTo("denied");

  const stateResult = verifyOAuthState(url.searchParams.get("state"), config.stateSecret);
  if (!stateResult.valid) return redirectTo(`invalid-state-${stateResult.reason}`);

  const code = url.searchParams.get("code");
  if (!code) return redirectTo("missing-code");

  // Exchange the one-time code for tokens.
  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    // The body can contain the client secret's error context; log the status only.
    console.error("[gmail-oauth] token exchange failed", tokenResponse.status);
    return redirectTo("exchange-failed");
  }

  const token = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  };
  if (!token.refresh_token) {
    // Happens when the mailbox has consented before and the consent URL omitted
    // prompt=consent. buildConsentUrl always sets it, so this means the grant
    // must be removed at myaccount.google.com and re-made.
    return redirectTo("no-refresh-token");
  }

  // Resolve which mailbox actually consented — the admin may hold several.
  let emailAddress = "unknown";
  if (token.access_token) {
    const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (profile.ok) {
      const json = (await profile.json()) as { email?: string };
      emailAddress = json.email ?? "unknown";
    }
  }

  const companyId = stateResult.payload.companyId ?? getRequestCompany()?.id;
  if (!companyId) return redirectTo("no-company");

  // company_id is unique, so reconnecting replaces the grant in place rather
  // than accumulating stale tokens.
  const { error } = await companyClient(companyId)
    .from("gmail_connections")
    .upsert(
      {
        company_id: companyId,
        email_address: emailAddress,
        refresh_token: token.refresh_token,
        scope: token.scope ?? null,
        token_type: token.token_type ?? null,
        connected_by: stateResult.payload.userId,
        connected_at: new Date().toISOString(),
        last_sync_error: null,
      },
      { onConflict: "company_id" },
    );
  if (error) {
    console.error("[gmail-oauth] failed to persist connection", error.message);
    return redirectTo("save-failed");
  }

  return redirectTo("connected");
}

export const Route = createFileRoute("/api/oauth/google/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleCallback(request),
    },
  },
});
