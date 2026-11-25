import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildConsentUrl,
  GOOGLE_REVOKE_ENDPOINT,
  readGmailOAuthConfig,
} from "@/lib/gmailOAuthConfig";
import { createOAuthState } from "@/lib/oauthState";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";
import { requirePermission, type PermissionContext } from "@/fns/requirePermission";

/**
 * Starting and ending the Gmail connection.
 *
 * These are server functions rather than GET routes because this app
 * authenticates server calls with `Authorization: Bearer <access_token>`
 * (integrations/supabase/auth-middleware.ts). A browser navigating to a GET
 * route sends no such header, so an admin-gated `/api/oauth/google/start` would
 * reject the very click that starts the flow. The page calls this, gets a URL
 * back, and navigates to it itself.
 *
 * The *callback* is a GET route, because Google redirects the browser there. It
 * carries no session and does not need one — the signed `state` authenticates
 * it, which is exactly what state exists for.
 */

/** يقصر ربط صندوق البريد أو فصله على من يملك صلاحية إدارة التكاملات، ويسجّل الرفض. */
async function assertCanManageIntegrations(context: PermissionContext) {
  await requirePermission(context, {
    code: "settings.integrations",
    attempted: "gmail.manage_connection",
    refusal: "You do not have permission to connect or disconnect a mailbox.",
  });
}

export const beginGmailOAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCanManageIntegrations(context as never);

    const config = readGmailOAuthConfig();
    if (!config) {
      throw new Error(
        "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REDIRECT_URI.",
      );
    }

    const state = createOAuthState(context.userId, config.stateSecret);
    return { url: buildConsentUrl(config, state) };
  });

export const disconnectGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCanManageIntegrations(context as never);

    // Read the token with the service-role client — `authenticated` has no
    // column grant on refresh_token, deliberately.
    const { data: connection } = await supabaseAdmin
      .from("gmail_connections")
      .select("id, refresh_token")
      .limit(1)
      .maybeSingle();

    if (!connection) return { disconnected: false };

    // Revoke at Google before forgetting locally: deleting the row alone leaves
    // a live grant on the mailbox that nobody can see or withdraw from here.
    // A revoke failure must not strand the row, so it is best-effort.
    try {
      await fetch(GOOGLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: connection.refresh_token }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn("[gmail-oauth] token revoke failed; deleting the connection anyway", error);
    }

    const { error } = await supabaseAdmin
      .from("gmail_connections")
      .delete()
      .eq("id", connection.id);
    if (error) throw new Error(`Failed to disconnect Gmail: ${error.message}`);

    return { disconnected: true };
  });
