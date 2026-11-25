import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  describeGmailApiError,
  getGmailAccessToken,
  GMAIL_API,
  grantCanModify,
  readGmailGrant,
} from "@/lib/gmailClient.server";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";
import { resolveGmailId } from "@/lib/gmailMessage";
import { requirePermission } from "@/fns/requirePermission";

/**
 * Deletes inbox messages by moving them to Trash in Gmail.
 *
 * Deleting the local row alone did not delete anything: the sync job lists the
 * same 30-day window on its next tick and inserts the message straight back.
 * Trashed mail is excluded from `users.messages.list` unless
 * `includeSpamTrash=true`, which the sync job does not set — that exclusion is
 * the whole mechanism, so the local delete must follow a successful trash.
 *
 * **Fails closed.** A message that cannot be trashed keeps its local row and is
 * reported. Deleting locally after a failed trash would reproduce the exact bug
 * this replaces, only with the mailbox untouched and the admin told it worked.
 *
 * Admin-gated to match migration 50, where deleting a gmail_messages row is
 * admin-only while reading and mark-read are staff-level. The check is explicit
 * because this runs under service_role and inherits no RLS.
 *
 * Errors are thrown as `Error`, never `Response`: TanStack Start hands a thrown
 * Response back to the caller instead of rejecting, which turns a refusal into
 * a success toast.
 */

const schema = z.object({
  // Bounded because each id costs one serial Gmail round trip.
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export const gmailTrashMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "inbox.manage",
      attempted: "gmail.trash_messages",
      refusal: "You do not have permission to delete inbox messages.",
    });

    // Rows are read *before* any Gmail precondition, because whether Gmail is
    // needed at all depends on what was selected. Demanding a connection to
    // delete a Resend-only selection would block a delete that never touches
    // Google — the Gmail requirement is a property of the rows, not of the
    // action.
    const { data: rows, error } = await supabaseAdmin
      .from("gmail_messages")
      .select("id, message_id, raw_payload, provider")
      .in("id", data.ids);
    if (error) throw new Error(error.message);

    const needsGmail = (rows ?? []).some((row) => row.provider !== "resend");

    let authHeader: { Authorization: string } | null = null;
    let gmailAddress: string | null = null;
    if (needsGmail) {
      const grant = await readGmailGrant();
      if (!grant) {
        throw new Error("Gmail is not connected. Connect it in Settings → Integrations.");
      }
      // Checked before any work: letting it through costs a token refresh and a
      // request per message before Google answers "insufficient scopes", which
      // reaches the admin as an error code rather than the one-click fix.
      //
      // Routed through the same `describeGmailApiError` helper the in-loop 403
      // uses below, with `feature: "deleting"` — there is no real Gmail response
      // here to parse (the scope is known locally, before any request is made),
      // but the synthesized body still matches the helper's 403 pattern, and
      // having one function produce this wording means the pre-flight and the
      // live-403 paths cannot drift apart the way they did before.
      if (!grantCanModify(grant.scope)) {
        throw new Error(
          describeGmailApiError(403, "insufficient authentication scopes", "deleting"),
        );
      }
      const accessToken = await getGmailAccessToken(grant.credentials);
      authHeader = { Authorization: `Bearer ${accessToken}` };
      gmailAddress = grant.credentials.address;
    }

    let trashed = 0;
    const failed: Array<{ id: string; reason: string }> = [];

    for (const row of rows ?? []) {
      // A Resend message has no Gmail counterpart, so there is nothing at the
      // provider to trash — only the local row. Without this branch
      // `resolveGmailId` happily returns the Resend id from `raw_payload`, the
      // Gmail API is asked to trash a message it has never heard of, and the
      // row survives every delete attempt with an unexplained provider error.
      if (row.provider === "resend") {
        const removed = await supabaseAdmin.from("gmail_messages").delete().eq("id", row.id);
        if (removed.error) {
          failed.push({ id: row.id, reason: removed.error.message });
          continue;
        }
        trashed += 1;
        continue;
      }

      const gmailId = resolveGmailId(row as { message_id: string; raw_payload: unknown });
      if (!gmailId) {
        failed.push({
          id: row.id,
          reason: "This message has no Gmail id stored, so it cannot be deleted in Gmail.",
        });
        continue;
      }

      // A thrown fetch (DNS failure, socket reset, abort) is caught here rather
      // than left to propagate: letting it reject the whole handler would
      // discard every {trashed, failed} result already accumulated for ids
      // processed earlier in this same call, and the admin would see a bare
      // error toast instead of "3 deleted, 2 failed". No row is at risk either
      // way — the local delete below is unreachable unless `response.ok` — but
      // partial progress should survive a single message's network failure.
      let response: Response;
      try {
        response = await fetch(`${GMAIL_API}/${gmailAddress}/messages/${gmailId}/trash`, {
          method: "POST",
          headers: authHeader as { Authorization: string },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
      } catch (err) {
        failed.push({
          id: row.id,
          reason: err instanceof Error ? err.message : "Gmail request failed unexpectedly.",
        });
        continue;
      }
      if (!response.ok) {
        failed.push({
          id: row.id,
          reason: describeGmailApiError(response.status, await response.text(), "deleting"),
        });
        continue;
      }

      const removed = await supabaseAdmin.from("gmail_messages").delete().eq("id", row.id);
      if (removed.error) {
        // Gmail has it in Trash; the local row will disappear on the next
        // successful attempt. Reported rather than swallowed.
        failed.push({ id: row.id, reason: removed.error.message });
        continue;
      }
      trashed += 1;
    }

    return { trashed, failed };
  });
