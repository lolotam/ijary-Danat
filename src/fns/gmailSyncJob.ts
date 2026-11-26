import { companyClient } from "@/company/companyClient.server";
import {
  getRequestCompany,
  requireRequestCompany,
  runWithRequestCompany,
} from "@/company/requestCompany.server";
import type { Json } from "@/integrations/supabase/database.types";
import {
  describeGmailApiError,
  getGmailAccessToken,
  GMAIL_API,
  readGmailGrant,
  type GmailCredentials,
} from "@/lib/gmailClient.server";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";
import { classifyGmailDirection, classifyGmailIsRead } from "@/lib/gmailDirection";
import { failedRecipientsHeaderValue } from "@/lib/gmailDeliveryFailure";
import { extractPlainText, headerValue, type GmailMessagePayload } from "@/lib/gmailMessage";

/**
 * Gmail inbox sync.
 *
 * Pulls recent messages from the connected Gmail account into the
 * `gmail_messages` table so they appear in the unified admin Inbox's "Gmail"
 * tab. Runs as a cron job (registered in src/fns/cronJobs.ts as "gmail-sync").
 *
 * The refresh token comes from the `gmail_connections` row an admin created via
 * /admin/settings/integrations. GMAIL_REFRESH_TOKEN remains a fallback so a
 * deployment wired by hand before the OAuth flow existed keeps working.
 *
 * Configuration (environment):
 * - GMAIL_CLIENT_ID
 * - GMAIL_CLIENT_SECRET
 * - GMAIL_REFRESH_TOKEN (fallback only; prefer the in-app connection)
 * - GMAIL_SYNC_ADDRESS (optional; defaults to "me" — the authenticated user)
 * - GMAIL_SYNC_WINDOW (optional; a Gmail `newer_than` value, default "30d")
 *
 * With no stored connection and no fallback token, the job no-ops (returns
 * `{ synced: 0, reason: "not-configured" }`) instead of throwing, so the cron
 * tick stays green on environments that haven't wired Gmail yet.
 *
 * Idempotency: inserts use `onConflict: do nothing` keyed on
 * `(company_id, message_id)`, so re-running over the same window cannot
 * duplicate rows.
 */

/** Messages requested per list call — Gmail's own page size. */
const PAGE_SIZE = 100;
/**
 * Caps on a single tick. Each *new* message costs one serial `format=full` GET,
 * so an uncapped run against a real mailbox would walk every message ever
 * received, one request at a time, and insert them all as unread. The window
 * bound below is the primary defence; these are the backstop.
 */
const MAX_PAGES = 5;
const MAX_MESSAGES = 250;

/**
 * Gmail's real per-minute budget for `messages.get?format=full`, measured.
 *
 * The published quota table prices that call at 5 units against a 6,000
 * units/minute/user limit, which would allow 1,200 of them. Measured against
 * the live mailbox on 2026-09-14 it allowed **105**: 99 succeeded, and a second
 * batch fired immediately after was refused at number 6. So a full get costs
 * nearer 57 units, and any run that fetches more than about a hundred messages
 * inside a minute will be refused partway through — which is what happened
 * every ten minutes, always ~27 seconds in.
 *
 * The diff below is what keeps a steady-state run at zero gets; this cap is the
 * backstop for a first run against a mailbox with more history than the window.
 */
const MAX_FETCHES_PER_RUN = 90;
/** How far back a tick looks. Gmail search syntax; see GMAIL_SYNC_WINDOW. */
const DEFAULT_SYNC_WINDOW = "30d";

interface GmailConfig extends GmailCredentials {
  /** Sync-only: how far back a tick looks. Gmail search syntax. */
  window: string;
}

/**
 * Resolves the credential to sync with.
 *
 * Credential resolution is shared with the send and attachment paths
 * (lib/gmailClient.server.ts); only the sync window is local to this job.
 */
async function readConfig(): Promise<{ config: GmailConfig; connectionId: string | null } | null> {
  const grant = await readGmailGrant();
  if (!grant) return null;

  return {
    connectionId: grant.connectionId,
    config: {
      ...grant.credentials,
      window: process.env.GMAIL_SYNC_WINDOW || DEFAULT_SYNC_WINDOW,
    },
  };
}

/** Records the outcome so the settings page can show it without a log dive. */
async function recordSyncOutcome(
  companyId: string,
  connectionId: string | null,
  error: string | null,
): Promise<void> {
  if (!connectionId) return;
  await companyClient(companyId)
    .from("gmail_connections")
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: error })
    .eq("id", connectionId);
}

interface GmailListMessage {
  id: string;
  threadId?: string;
}

interface GmailMessageFull {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailMessagePayload;
  internalDate?: string;
  /** Present on format=full responses; drives direction (migration 100). */
  labelIds?: string[];
}

/**
 * The per-message uniqueness key.
 *
 * Prefers the RFC 822 Message-ID header, which is stable across mailboxes.
 * Falls back to Gmail's own message id, which is immutable within a mailbox and
 * — unlike `threadId` — always present. The column is NOT NULL precisely so
 * this fallback is mandatory: a null here would defeat the unique constraint,
 * because null is never equal to null.
 */
export function resolveMessageKey(headerMessageId: string | null, gmailId: string): string {
  const trimmed = headerMessageId?.trim();
  return trimmed ? trimmed : `gmail:${gmailId}`;
}

/**
 * خطأ يعني أن حصة Gmail نفدت لهذه الدقيقة، لا أن شيئاً تعطّل.
 *
 * Distinguished from every other failure because the response is "come back
 * shortly", and the pages already written are still good. The caller stops
 * cleanly rather than failing the tick.
 */
class GmailRateLimitError extends Error {
  constructor() {
    super(
      "Gmail's per-minute quota was reached; the remaining messages will sync on the next tick.",
    );
    this.name = "GmailRateLimitError";
  }
}

/**
 * يميّز نفاد الحصة عن الرفض الحقيقي.
 *
 * Gmail answers a spent quota with 403 and `rateLimitExceeded`, not 429 — and
 * 403 is also how it answers a missing scope, which is a real fault needing an
 * admin to reconnect. The reason string is the only thing separating them.
 */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded|quota/i.test(body);
}

/** One page of message ids, plus the token for the next page if any. */
async function listMessagePage(
  config: GmailConfig,
  authHeader: Record<string, string>,
  pageToken: string | null,
): Promise<{ messages: GmailListMessage[]; nextPageToken: string | null }> {
  const listUrl = new URL(`${GMAIL_API}/${config.address}/messages`);
  listUrl.searchParams.set("maxResults", String(PAGE_SIZE));
  // Bounds a first run: without it, page one of an established mailbox is
  // merely the newest 100 of tens of thousands, all of which we would then walk.
  listUrl.searchParams.set("q", `newer_than:${config.window}`);
  if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

  const response = await fetch(listUrl, {
    headers: authHeader,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    if (isRateLimited(response.status, text)) throw new GmailRateLimitError();
    throw new Error(
      `Gmail list failed: ${describeGmailApiError(response.status, text, "syncing")}`,
    );
  }
  const json = (await response.json()) as {
    messages?: GmailListMessage[];
    nextPageToken?: string;
  };
  return { messages: json.messages ?? [], nextPageToken: json.nextPageToken ?? null };
}

/**
 * صف جاهز للكتابة، ومعه معرّف Gmail الخاص به.
 *
 * The id is carried alongside rather than inside the row because it is not a
 * writable column — `gmail_id` is generated — yet the hydrate step below needs
 * it to find the thin placeholder a send may already have left behind.
 */
type BuiltRow = { gmailId: string; row: InsertRow };

interface SyncResult {
  synced: number;
  reason?: string;
}

type InsertRow = {
  company_id: string;
  message_id: string;
  thread_id: string | null;
  from_address: string;
  to_address: string | null;
  subject: string | null;
  snippet: string | null;
  /** Migration 138 — X-Failed-Recipients, null when the header is absent. */
  failed_recipients: string | null;
  body_text: string | null;
  received_at: string;
  is_read: boolean;
  /** Migration 100 — SENT wins when both SENT and INBOX are present. */
  direction: "received" | "sent";
  raw_payload: Json;
};

/**
 * يعيد من المعرّفات المعروضة تلك التي لم تُخزَّن بعد.
 *
 * This is the whole fix. The job used to fetch every listed message on every
 * tick and then throw the duplicates away, because the upsert runs with
 * `ignoreDuplicates` — 208 `format=full` gets every ten minutes to learn
 * nothing. One indexed read replaces all of them.
 *
 * Skipping a stored message loses no updates: `ignoreDuplicates` meant an
 * existing row was never overwritten anyway, which is deliberate — it is what
 * keeps a staff member's mark-as-read from being undone by the next sync.
 *
 * It also does not skip the **thin** rows `gmailSend` writes when a message
 * leaves the app. Those carry the Gmail id but no MIME tree, and three readers
 * need that tree — the message sheet, the attachment fetch, and the reply
 * threading headers. Migration 208 leaves their `gmail_id` NULL for exactly
 * this reason, so the diff never matches them and the sync still fetches the
 * real payload.
 *
 * On a read error every id is treated as new. That is the safe direction: a
 * wasted fetch costs quota, a wrongly skipped message is never stored at all.
 */
async function unseenMessages(
  db: ReturnType<typeof companyClient>,
  companyId: string,
  messages: GmailListMessage[],
): Promise<GmailListMessage[]> {
  if (messages.length === 0) return [];

  const { data, error } = await db
    .from("gmail_messages")
    .select("gmail_id")
    .eq("company_id", companyId)
    .in(
      "gmail_id",
      messages.map((message) => message.id),
    );
  if (error) {
    console.error("gmail-sync: could not read stored ids, refetching the page", error.message);
    return messages;
  }

  const stored = new Set((data ?? []).flatMap((row) => (row.gmail_id ? [row.gmail_id] : [])));
  return messages.filter((message) => !stored.has(message.id));
}

/**
 * Fetches full metadata for one page of listed ids.
 *
 * Serial by necessity — Gmail has no cheap batch GET — which is precisely why
 * the caller writes each page as it completes rather than at the end.
 */
async function buildRows(
  config: GmailConfig,
  authHeader: Record<string, string>,
  companyId: string,
  messages: GmailListMessage[],
): Promise<{ rows: BuiltRow[]; throttled: boolean }> {
  const rows: BuiltRow[] = [];
  for (const message of messages) {
    const metaUrl = new URL(`${GMAIL_API}/${config.address}/messages/${message.id}`);
    metaUrl.searchParams.set("format", "full");
    const metaResponse = await fetch(metaUrl, {
      headers: authHeader,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!metaResponse.ok) {
      // A spent quota used to be swallowed by this `continue` along with
      // genuinely unreadable messages, so the run carried on issuing requests
      // that could only be refused, and the failure finally surfaced on the
      // next *list* call — pointing at the wrong thing entirely.
      //
      // It is reported rather than thrown so the caller can still write the
      // messages fetched before the limit. Throwing discarded them, and since
      // the next tick lists the same window it would fetch them again and be
      // refused at the same point — a run that costs its whole budget and never
      // advances.
      if (isRateLimited(metaResponse.status, await metaResponse.text())) {
        return { rows, throttled: true };
      }
      continue; // skip unreadable messages
    }
    const meta = (await metaResponse.json()) as GmailMessageFull;
    const payload = meta.payload;
    // internalDate is epoch ms as a string.
    const receivedAt = meta.internalDate
      ? new Date(Number(meta.internalDate)).toISOString()
      : new Date().toISOString();
    rows.push({
      gmailId: meta.id,
      row: {
        company_id: companyId,
        message_id: resolveMessageKey(headerValue(payload, "Message-ID"), meta.id),
        thread_id: meta.threadId ?? null,
        from_address: headerValue(payload, "From") ?? "unknown",
        to_address: headerValue(payload, "To"),
        subject: headerValue(payload, "Subject"),
        snippet: meta.snippet ?? null,
        failed_recipients: failedRecipientsHeaderValue(payload?.headers),
        // Nearly all real mail is multipart, so this walks the MIME tree.
        body_text: extractPlainText(payload),
        received_at: receivedAt,
        // Derived from Gmail's UNREAD label on this same format=full response.
        // Missing/empty labelIds → unread (safe default). ignoreDuplicates means
        // existing rows are never overwritten, so staff mark-read stays intact.
        is_read: classifyGmailIsRead(meta.labelIds),
        // List query has no label filter, so SENT mail already arrives here.
        // Same SENT-wins rule as the migration 100 backfill.
        direction: classifyGmailDirection(meta.labelIds),
        raw_payload: meta as unknown as Json,
      },
    });
  }
  return { rows, throttled: false };
}

/**
 * يملأ الصف المختصر الذي خلّفه الإرسال من داخل التطبيق بدل إضافة صف ثانٍ.
 *
 * `recordLocalSentMessage` keys its placeholder on the bare Gmail id, while a
 * synced row is keyed on the RFC 822 Message-ID header. Those are different
 * strings, so `upsert(..., onConflict: "company_id,message_id")` does not see a
 * conflict and inserts a *second* row — which is why production holds two rows
 * for every message ever sent from the app, one of them permanently without a
 * MIME tree. The keys cannot simply be aligned: at send time Gmail has not yet
 * assigned the header the synced row will use.
 *
 * So the placeholder is filled in place. Only the fields the full payload
 * actually supplies are written: `is_read`, `direction` and `received_at` stay
 * as the send left them, because the staff member who sent the message has
 * already read it and a label-derived value would only undo that.
 *
 * Returns the Gmail ids it handled, so the caller does not then insert the
 * duplicate this exists to prevent.
 */
async function hydrateSentPlaceholders(
  db: ReturnType<typeof companyClient>,
  companyId: string,
  built: BuiltRow[],
): Promise<Set<string>> {
  const hydrated = new Set<string>();

  for (const { gmailId, row } of built) {
    const { data, error } = await db
      .from("gmail_messages")
      .update({
        thread_id: row.thread_id,
        to_address: row.to_address,
        subject: row.subject,
        snippet: row.snippet,
        body_text: row.body_text,
        failed_recipients: row.failed_recipients,
        raw_payload: row.raw_payload,
      })
      .eq("company_id", companyId)
      // The placeholder's key is the bare Gmail id — the one thing that
      // identifies it without the header the synced row is keyed on.
      .eq("message_id", gmailId)
      .is("gmail_id", null)
      .select("id");

    if (error) {
      // Falling through to the insert is the safe direction: at worst it
      // recreates the duplicate that exists today, rather than dropping a
      // message entirely.
      console.error("gmail-sync: could not hydrate a sent placeholder", error.message);
      continue;
    }
    if (data?.length) hydrated.add(gmailId);
  }

  return hydrated;
}

/**
 * Syncs page by page, writing each page before listing the next.
 *
 * The write placement is the point. A full run is up to 250 serial message
 * fetches, and the cron entry reaches this through Cloudflare, which caps
 * request duration. Accumulating everything and upserting once at the end
 * meant a run cut short persisted *nothing* — and since the next tick lists
 * the same window and does the same work, it would never make progress. It
 * would look like "Gmail just doesn't sync", with no error to chase.
 *
 * Writing per page makes progress durable: a truncated run still leaves the
 * pages it finished, and because the upsert ignores duplicates, the next tick
 * skips them cheaply and gets further.
 */
async function syncMailbox(companyId: string, config: GmailConfig): Promise<SyncResult> {
  const db = companyClient(companyId);
  const accessToken = await getGmailAccessToken(config);
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  let synced = 0;
  let considered = 0;
  let fetched = 0;
  let pageToken: string | null = null;
  let throttled = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const listResult = await listMessagePage(config, authHeader, pageToken);
      const batch = listResult.messages.slice(0, MAX_MESSAGES - considered);
      considered += batch.length;

      // The messages already in the table are skipped before a single request
      // is spent on them, which is what keeps a steady-state run inside Gmail's
      // per-minute budget — and, in the normal case of no new mail, at zero
      // message fetches.
      const unseen = (await unseenMessages(db, companyId, batch)).slice(
        0,
        MAX_FETCHES_PER_RUN - fetched,
      );

      if (unseen.length) {
        const built = await buildRows(config, authHeader, companyId, unseen);
        fetched += unseen.length;
        if (built.rows.length) {
          // A message sent from the app already has a row; it just has no MIME
          // tree. Filling it beats adding a second row beside it.
          const hydrated = await hydrateSentPlaceholders(db, companyId, built.rows);
          const fresh = built.rows.filter((entry) => !hydrated.has(entry.gmailId));

          if (fresh.length) {
            // Idempotent — re-syncing the same window cannot duplicate rows.
            const { error: insertError } = await db.from("gmail_messages").upsert(
              fresh.map((entry) => entry.row),
              { onConflict: "company_id,message_id", ignoreDuplicates: true },
            );
            if (insertError) throw new Error(`gmail-sync insert: ${insertError.message}`);
          }
          synced += built.rows.length;
        }
        // Written first, then stopped: whatever this run managed to fetch is
        // durable, so the next tick's diff is shorter and it gets further.
        if (built.throttled) {
          throttled = true;
          break;
        }
      }

      pageToken = listResult.nextPageToken;
      if (!pageToken || considered >= MAX_MESSAGES || fetched >= MAX_FETCHES_PER_RUN) break;
    }
  } catch (error) {
    // A spent quota is not a failed tick. The pages already written are durable
    // and the next run — ten minutes later, with a fresh budget and a shorter
    // diff because of what this run stored — continues from there. Failing here
    // would mark the job red every ten minutes while it was, in fact, making
    // progress.
    if (!(error instanceof GmailRateLimitError)) throw error;
    throttled = true;
  }

  return throttled ? { synced, reason: "rate-limited" } : { synced };
}

/**
 * يزامن رسائل صندوق Gmail الخاصة بالشركة المحددة أو شركة الطلب الحالية.
 */
export async function runGmailSyncJob(
  _asOf?: string | null,
  explicitCompanyId?: string,
): Promise<SyncResult> {
  const activeCompany = getRequestCompany();
  const companyId = explicitCompanyId ?? requireRequestCompany().id;
  const companyContext =
    activeCompany?.id === companyId
      ? activeCompany
      : { id: companyId, slug: "", status: "active" as const, host: "" };
  return runWithRequestCompany(companyContext, async () => {
    const resolved = await readConfig();
    if (!resolved) return { synced: 0, reason: "not-configured" };

    const { config, connectionId } = resolved;
    try {
      const result = await syncMailbox(companyId, config);
      await recordSyncOutcome(companyId, connectionId, null);
      return result;
    } catch (error) {
      // Surfaced on the integrations page. The job still throws so the cron tick
      // reports red — recording the reason is for the admin, not a substitute.
      await recordSyncOutcome(
        companyId,
        connectionId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
}
