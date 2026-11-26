import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany, requireRequestCompany } from "@/company/requestCompany.server";
import { loadEvolutionProviderConfig } from "@/fns/evolutionSession";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";
import type { EvolutionClient } from "@/lib/evolution/client";
import { maskJid } from "@/lib/evolution/client";
import { isAvatarUrlExpired } from "@/lib/whatsappAvatar";
import { requirePermission } from "@/fns/requirePermission";

/**
 * مزامنة صور الملفات الشخصية لواتساب من Evolution إلى الصندوق.
 *
 * `findChats`/`findContacts` — the only source before this — carry
 * `profilePicUrl` for whichever contacts Baileys happened to cache at pairing,
 * which on production meant 4 pictures across 43 chats. Everything here goes
 * through the per-number `fetchProfilePictureUrl` endpoint instead, so a chat
 * shows the same picture the phone shows from its first message onward.
 */

/** Numbers fetched per sweep — each is one round trip to the gateway. */
const NUMBERS_PER_RUN = 60;
/** Wall-clock budget, so the server fn answers before a proxy gives up. */
const BUDGET_MS = 45_000;
/**
 * Numbers a single message batch may look up.
 *
 * MESSAGES_UPSERT can carry a burst from many chats at once. The lookups run
 * concurrently and off the response path, but an unbounded fan-out at a
 * gateway that is already rate-sensitive is its own problem; the rest of the
 * burst gets its pictures from the next message or from the Settings sweep.
 */
const BACKFILL_PER_BATCH = 5;
/**
 * Per-lookup timeout for the backfill, well under the client's 10s default.
 *
 * A picture is decoration on a message that already arrived: if the gateway
 * cannot answer in four seconds, waiting longer buys nothing and holds a
 * connection during exactly the outage that made it slow.
 */
const BACKFILL_TIMEOUT_MS = 4_000;

/** يختصر الخطأ إلى نص قابل للتسجيل دون كشف تفاصيل الاستجابة. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * يستخرج رابط الصورة من استجابة Evolution بأشكالها المختلفة.
 *
 * v2.3.7 answers `{ profilePictureUrl }`; a number with no picture answers with
 * that field null or absent, which is not an error condition.
 */
function pictureUrlOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const url = record.profilePictureUrl ?? record.profilePicUrl;
  return typeof url === "string" && url.startsWith("http") ? url : null;
}

/**
 * يكتب رابط الصورة — أو يمحوه — في جدولي المحادثات وجهات الاتصال لرقم واحد.
 *
 * Both tables carry their own `avatar_url` (migration 184) and the inbox reads
 * the chat's first, the contact's as fallback — writing one and not the other
 * is how a thread and its contact row come to show different pictures. A null
 * url clears them, which is what a contact who removed their picture or turned
 * on a privacy setting has to produce: otherwise the inbox keeps showing a face
 * its owner has taken down, until a CDN expiry that some URLs never carry.
 */
async function storeAvatar(companyId: string, number: string, url: string | null): Promise<void> {
  const db = companyClient(companyId);
  const chat = await db
    .from("whatsapp_chats")
    .update({ avatar_url: url })
    .eq("chat_number", number);
  if (chat.error) throw new Error(chat.error.message);
  const contact = await db
    .from("whatsapp_contacts")
    .update({ avatar_url: url })
    .eq("phone", number);
  if (contact.error) throw new Error(contact.error.message);
}

/**
 * يجلب صورة رقم واحد ويخزّنها، أو يمحو المخزّن إن لم تعد له صورة.
 *
 * Returns whether a picture was stored — the count the sweep reports. A
 * successful "no picture" answer is not a failure and still writes: it is the
 * only signal we get that a picture was taken down.
 */
async function syncOne(
  companyId: string,
  client: EvolutionClient,
  instanceName: string,
  number: string,
): Promise<boolean> {
  const url = pictureUrlOf(await client.fetchProfilePictureUrl(instanceName, number));
  await storeAvatar(companyId, number, url);
  return url !== null;
}

/**
 * يقرأ اسم النسخة المقترنة، أو null إذا لم تكن هناك جلسة مفتوحة.
 */
async function openInstanceName(companyId: string): Promise<string | null> {
  const connection = await companyClient(companyId)
    .from("evolution_connections")
    .select("instance_name, last_connection_state")
    .eq("id", 1)
    .maybeSingle();
  if (connection.error) throw new Error(connection.error.message);
  if (!connection.data || connection.data.last_connection_state !== "open") return null;
  return connection.data.instance_name;
}

/** الصورة المخزّنة لرقم في كل من الجدولين، بعد استبعاد الروابط المنتهية. */
interface StoredAvatar {
  chat: string | null;
  contact: string | null;
}

/**
 * يقرأ الصور المخزّنة للأرقام المطلوبة من الجدولين في استعلامين محدودين.
 *
 * An expired CDN link is reported as absent: the row "has" a picture that no
 * longer loads, and the next message is the cheapest moment to replace it.
 */
async function storedAvatars(
  companyId: string,
  numbers: string[],
): Promise<Map<string, StoredAvatar>> {
  const db = companyClient(companyId);
  const chats = await db
    .from("whatsapp_chats")
    .select("chat_number, avatar_url")
    .in("chat_number", numbers);
  if (chats.error) throw new Error(chats.error.message);
  const contacts = await db
    .from("whatsapp_contacts")
    .select("phone, avatar_url")
    .in("phone", numbers);
  if (contacts.error) throw new Error(contacts.error.message);

  const usable = (url: string | null) => (url && !isAvatarUrlExpired(url) ? url : null);
  const map = new Map<string, StoredAvatar>();
  for (const number of numbers) map.set(number, { chat: null, contact: null });
  for (const row of chats.data ?? []) {
    const entry = map.get(row.chat_number);
    if (entry) entry.chat = usable(row.avatar_url);
  }
  for (const row of contacts.data ?? []) {
    const entry = map.get(row.phone);
    if (entry) entry.contact = usable(row.avatar_url);
  }
  return map;
}

/**
 * يجلب صور الأرقام التي لا صورة لها بعد — يُستدعى عند أول رسالة صادرة أو واردة.
 *
 * Best effort by construction: a picture is decoration on a message that has
 * already been sent or received, so a gateway timeout here must never fail the
 * send or reject the webhook. Numbers that already carry a usable picture in
 * both tables are filtered out first, which makes this two cheap queries and no
 * gateway traffic in the common case — every message after the first in a chat.
 */
export async function backfillChatAvatars(
  numbers: string[],
  explicitCompanyId?: string,
): Promise<void> {
  const unique = [...new Set(numbers.filter(Boolean))];
  if (!unique.length) return;
  try {
    const companyId = explicitCompanyId ?? requireRequestCompany().id;
    const stored = await storedAvatars(companyId, unique);
    // Both tables are consulted, not just the chat. History sync fills them
    // from different Evolution endpoints, so a number can easily have a picture
    // on its chat row and none on its contact row — and the contacts table
    // would then sit on initials forever, since the chat row alone made every
    // later message look complete.
    const gaps = unique
      .map((number) => ({ number, ...(stored.get(number) ?? { chat: null, contact: null }) }))
      .filter((row) => !row.chat || !row.contact);
    if (!gaps.length) return;

    // A gap one side can fill from the other costs no gateway call at all.
    const copyable = gaps.filter((row) => row.chat || row.contact);
    await Promise.allSettled(
      copyable.map((row) => storeAvatar(companyId, row.number, (row.chat ?? row.contact)!)),
    );

    const unknown = gaps.filter((row) => !row.chat && !row.contact).map((row) => row.number);
    if (!unknown.length) return;

    const instanceName = await openInstanceName(companyId);
    if (!instanceName) return;
    const client = evolutionClientFromConfig(
      (await loadEvolutionProviderConfig(companyId)).config,
      undefined,
      BACKFILL_TIMEOUT_MS,
    );
    // allSettled, not a sequential loop: one unreachable number would otherwise
    // add its whole timeout to every number behind it in the batch.
    const outcomes = await Promise.allSettled(
      unknown
        .slice(0, BACKFILL_PER_BATCH)
        .map((number) => syncOne(companyId, client, instanceName, number)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        console.error("[evolutionAvatars] lookup failed:", describeError(outcome.reason));
      }
    }
  } catch (error) {
    // maskJid so a failure log never carries a full subscriber number.
    console.error(
      "[evolutionAvatars] avatar backfill failed for",
      unique.map((number) => maskJid(number)).join(","),
      describeError(error),
    );
  }
}

/**
 * يشغّل جلب الصور في الخلفية دون أن تنتظره الاستجابة.
 *
 * The webhook must answer Evolution promptly — a slow 200 is a retry, and a
 * retried batch is more work for the same pictures — and an outbound send has
 * already reached the tenant by the time this runs. Nothing awaits the result
 * because there is no caller decision that depends on it;
 * `backfillChatAvatars` swallows its own failures, so the floating promise
 * cannot become an unhandled rejection.
 */
export function backfillChatAvatarsInBackground(
  numbers: string[],
  explicitCompanyId?: string,
): void {
  const companyId = explicitCompanyId ?? getRequestCompany()?.id;
  void backfillChatAvatars(numbers, companyId);
}

/**
 * يجمع أرقام المحادثات وجهات الاتصال مرتّبة ترتيباً ثابتاً.
 *
 * Sorted by the number itself, not by whether it already has a picture. An
 * earlier version put pictureless numbers first to "make progress", which does
 * the opposite once there are more of them than one run can check: a number
 * whose owner hides their picture is pictureless forever, sorts to the front
 * every time, and consumes the ceiling that the untouched tail needed. A stable
 * order plus the cursor below is what actually walks the whole directory.
 */
async function numbersToSweep(companyId: string): Promise<string[]> {
  const db = companyClient(companyId);
  const chats = await db.from("whatsapp_chats").select("chat_number");
  if (chats.error) throw new Error(chats.error.message);
  const contacts = await db.from("whatsapp_contacts").select("phone");
  if (contacts.error) throw new Error(contacts.error.message);
  return [
    ...new Set([
      ...(chats.data ?? []).map((row) => row.chat_number),
      ...(contacts.data ?? []).map((row) => row.phone),
    ]),
  ]
    .filter((number): number is string => Boolean(number) && number !== "0")
    .sort();
}

export interface EvolutionAvatarSyncResult {
  /** Numbers asked about in this run. */
  checked: number;
  /** Numbers that came back with a picture and were stored. */
  updated: number;
  /** false = the ceiling or the time budget stopped the sweep — run it again. */
  complete: boolean;
  /**
   * Last number this run handled. Pass it back as `after` to continue from
   * there; null once the sweep has reached the end of the directory.
   */
  nextCursor: string | null;
}

/**
 * يمشّط كل المحادثات وجهات الاتصال ويحدّث صور الملفات الشخصية.
 *
 * Refreshes numbers that already have a picture too, rather than only filling
 * blanks: WhatsApp's CDN URLs expire, so a stored link goes dead on its own
 * and a row that "has" a picture can still be showing initials.
 *
 * A directory larger than one run's ceiling is walked across clicks by the
 * `after` cursor — the caller passes back the `nextCursor` it was handed, and
 * the run resumes past it. Without that, every run re-checks the same head of
 * the list and the tail is never reached.
 */
export const syncEvolutionAvatars = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown): { after?: string } => {
    const after = (input as { after?: unknown } | null)?.after;
    return typeof after === "string" && after ? { after } : {};
  })
  .handler(async ({ context, data }): Promise<EvolutionAvatarSyncResult> => {
    await requirePermission(context, {
      code: "settings.integrations",
      attempted: "whatsapp.sync_avatars",
      refusal: "You do not have permission to sync WhatsApp avatars.",
    });

    const companyId = requireRequestCompany().id;
    const instanceName = await openInstanceName(companyId);
    if (!instanceName) {
      throw new Error(
        "No open WhatsApp session. Scan the QR code in Settings → Integrations first.",
      );
    }
    const client = evolutionClientFromConfig((await loadEvolutionProviderConfig(companyId)).config);

    const after = data.after ?? null;
    const numbers = (await numbersToSweep(companyId)).filter((number) => !after || number > after);

    const deadline = Date.now() + BUDGET_MS;
    let checked = 0;
    let updated = 0;
    let cursor: string | null = after;
    for (const number of numbers) {
      if (checked >= NUMBERS_PER_RUN || Date.now() > deadline) {
        return { checked, updated, complete: false, nextCursor: cursor };
      }
      checked += 1;
      cursor = number;
      try {
        if (await syncOne(companyId, client, instanceName, number)) updated += 1;
      } catch (error) {
        // One unreachable number must not abandon the rest of the directory.
        console.error(
          "[evolutionAvatars] lookup failed for",
          maskJid(number),
          describeError(error),
        );
      }
    }
    return { checked, updated, complete: true, nextCursor: null };
  });
