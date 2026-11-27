import type { SupabaseClient } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { buildIngestRow } from "@/fns/evolutionIngestRow";
import {
  loadEvolutionProviderConfig,
  loadQrConnection,
  NO_OPEN_SESSION_MESSAGE,
} from "@/fns/evolutionSession.server";
import type { Database, Json } from "@/integrations/supabase/database.types";
import { collectMessagePage, maskJid, remoteNumberFor } from "@/lib/evolution/client";
import { evolutionClientFromConfig } from "@/lib/providers/evolution";

/**
 * مزامنة تاريخ المحادثات من مخزن Evolution إلى صندوق واتساب.
 *
 * Baileys pushes nothing for pre-pairing messages, so walking findChats /
 * findContacts / findMessages is the only backfill path. The sweep is bounded
 * (chat and page ceilings plus a wall-clock budget) and idempotent — the
 * ingest RPC dedupes on message_id — so a retried job imports nothing twice
 * and a truncated run (`complete: false`) is safe to repeat. History rows
 * carry count_unread: false; a year of imported chats must not light the
 * inbox badge.
 *
 * What Evolution does not hold cannot be synced: with the container's default
 * partial history, only the snapshot WhatsApp sent at pairing exists. Fuller
 * history needs CONFIG_SESSION_PHONE_SYNC_FULL_HISTORY=true and a re-pair.
 */

/** Chats walked per invocation; re-run continues (dedup makes it safe). */
const CHAT_LIMIT_PER_RUN = 25;
/** Page ceiling per chat — v2.3.7 caps a page at ~40 rows. */
const PAGES_PER_CHAT = 20;
/** Wall-clock budget so the server fn returns before proxies give up on it. */
const BUDGET_MS = 50_000;

type Rec = Record<string, unknown>;

/** يعيد القيمة كسجل مفاتيح إن كانت كائناً غير مصفوفي، أو null خلاف ذلك. */
function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

/**
 * يستخرج JID المحادثة من سجل findChats بأشكاله (remoteJid أو id).
 */
function chatJid(record: Rec): string | null {
  const value = record.remoteJid ?? record.id;
  return typeof value === "string" && value ? value : null;
}

/**
 * يستورد جهات الاتصال المخزّنة لدى Evolution (إدراج الجديد فقط).
 *
 * ignoreDuplicates: an existing contact may carry an admin-entered name, and
 * a bulk import must never overwrite it. Names for existing rows still arrive
 * through the message push-name fill-empty path in the ingest RPC.
 */
async function importContacts(
  db: ReturnType<typeof companyClient>,
  records: unknown[],
): Promise<number> {
  const rows = records
    .map((record) => {
      const contact = asRecord(record);
      if (!contact) return null;
      const jid =
        typeof contact.remoteJid === "string" ? contact.remoteJid : String(contact.id ?? "");
      if (!jid.endsWith("@s.whatsapp.net")) return null;
      const name = contact.pushName ?? contact.name;
      const avatar = contact.profilePicUrl;
      return {
        phone: remoteNumberFor(jid),
        name: typeof name === "string" && name.trim() ? name.trim() : null,
        avatar_url: typeof avatar === "string" && avatar ? avatar : null,
      };
    })
    .filter(
      (row): row is { phone: string; name: string | null; avatar_url: string | null } =>
        row !== null,
    );
  if (!rows.length) return 0;
  const result = await db
    .from("whatsapp_contacts")
    .upsert(rows, { onConflict: "phone", ignoreDuplicates: true })
    .select("id");
  if (result.error) throw new Error(result.error.message);
  // Refresh the picture on contacts that already existed — the insert above
  // deliberately never touches them (an admin-entered name must survive), but
  // an expired CDN URL should still be replaced with the fresh one.
  for (const row of rows) {
    if (!row.avatar_url) continue;
    const update = await db
      .from("whatsapp_contacts")
      .update({ avatar_url: row.avatar_url })
      .eq("phone", row.phone);
    if (update.error) throw new Error(update.error.message);
  }
  return result.data?.length ?? 0;
}

/**
 * يحلّ رقم هاتف محادثة LID عبر معرفات رسائل نملكها بالفعل.
 *
 * Evolution stores history under bare `@lid` ids with no phone alias, but it
 * normalises LIVE webhook events to the phone JID — so the message id is the
 * bridge: any id present both in the chat's history and in our inbox pins the
 * chat to the phone number the live event carried. One live message from a
 * contact therefore unlocks their entire history on the next sweep.
 */
async function lookupChatNumberByMessageIds(
  db: ReturnType<typeof companyClient>,
  ids: string[],
): Promise<string | null> {
  if (!ids.length) return null;
  const result = await db
    .from("whatsapp_messages")
    .select("chat_number")
    .in("message_id", ids)
    .neq("chat_number", "0")
    .limit(1);
  if (result.error) throw new Error(result.error.message);
  return result.data?.[0]?.chat_number ?? null;
}

export interface EvolutionHistorySyncResult {
  chatsWalked: number;
  chatsSkipped: number;
  /** @lid chats with no live message yet — they unlock as contacts write in. */
  chatsAwaitingLid: number;
  messagesImported: number;
  contactsImported: number;
  /** false = a ceiling or the time budget stopped the sweep — run it again. */
  complete: boolean;
}

/**
 * يقرأ جلسة واتساب المفتوحة للوصلة المطلوبة، أو يرفض إن لم تكن هناك جلسة.
 *
 * The connection is one row of `whatsapp_connections` (migration 333): the
 * company's ACTIVE `evolution_qr` link, read through the company's own client
 * and filtered by the company id, so another company's id finds nothing.
 */
export async function loadOpenEvolutionConnection(
  db: SupabaseClient<Database>,
  companyId: string,
  connectionId: string,
): Promise<{ instanceName: string }> {
  const row = await loadQrConnection(db, companyId, { connectionId });
  if (!row || row.status !== "connected" || !row.instance_name) {
    throw new Error(NO_OPEN_SESSION_MESSAGE);
  }
  return { instanceName: row.instance_name };
}

/**
 * يمشّط محادثات Evolution ويستورد رسائلها التاريخية إلى صندوق الوارد.
 *
 * Moved out of the server function when the sweep became the
 * `whatsapp.history.sync` job: one implementation, driven by the job handler
 * (`move, not copy`).
 */
export async function runEvolutionHistorySweep(input: {
  companyId: string;
  connectionId: string;
}): Promise<EvolutionHistorySyncResult> {
  const { companyId, connectionId } = input;
  const db = companyClient(companyId);

  const { instanceName } = await loadOpenEvolutionConnection(db, companyId, connectionId);
  const providerConfig = await loadEvolutionProviderConfig(companyId);
  const client = evolutionClientFromConfig(providerConfig.config);
  const deadline = Date.now() + BUDGET_MS;

  const contactRecords = (await client.findContacts(instanceName)) as unknown[];
  const contactsImported = Array.isArray(contactRecords)
    ? await importContacts(db, contactRecords)
    : 0;

  const chatRecords = (await client.findChats(instanceName)) as unknown[];
  const chats = (Array.isArray(chatRecords) ? chatRecords : [])
    .map((record) => asRecord(record))
    .filter((record): record is Rec => record !== null);

  let chatsWalked = 0;
  let chatsSkipped = 0;
  let chatsAwaitingLid = 0;
  let messagesImported = 0;
  let truncated = false;

  for (const chat of chats) {
    const jid = chatJid(chat);
    const isDirect = !!jid && jid.endsWith("@s.whatsapp.net") && jid !== "0@s.whatsapp.net";
    const isLid = !!jid && jid.endsWith("@lid");
    // Groups, newsletters and the WhatsApp system chat (0@) are out of scope
    // — the inbox is 1:1 tenant conversations keyed by phone number.
    if (!jid || (!isDirect && !isLid)) {
      chatsSkipped += 1;
      continue;
    }
    if (chatsWalked >= CHAT_LIMIT_PER_RUN || Date.now() > deadline) {
      truncated = true;
      break;
    }

    // LID chats resolve through message ids we already ingested live; a
    // chat with no live message yet stays pending, not failed.
    let firstPage: ReturnType<typeof collectMessagePage> | null = null;
    let resolveLidNumber: ((lidJid: string) => string | null) | undefined;
    if (isLid) {
      firstPage = collectMessagePage(
        await client.findMessages(instanceName, { remoteJid: jid, page: 1 }),
      );
      const knownIds = firstPage.records
        .map((item) => asRecord(asRecord(item)?.key)?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const phone = await lookupChatNumberByMessageIds(db, knownIds);
      if (!phone) {
        chatsAwaitingLid += 1;
        console.warn(`[evolution-history] no live anchor yet for ${maskJid(jid)}`);
        continue;
      }
      resolveLidNumber = () => phone;
    }
    chatsWalked += 1;

    for (let page = 1; page <= PAGES_PER_CHAT; page += 1) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const { records, totalPages } =
        page === 1 && firstPage
          ? firstPage
          : collectMessagePage(await client.findMessages(instanceName, { remoteJid: jid, page }));
      const rows = records
        .map((item) => {
          const record = asRecord(item);
          return record ? buildIngestRow(record, { countUnread: false, resolveLidNumber }) : null;
        })
        .filter((row): row is Rec => row !== null);
      if (rows.length) {
        const ingest = await db.rpc("ingest_whatsapp_messages", {
          p_rows: rows as unknown as Json,
        });
        if (ingest.error) throw new Error(ingest.error.message);
        messagesImported += ingest.data ?? 0;
      }
      // Bare-array deployments return everything at once; envelope
      // deployments terminate on `pages`, never on a short page.
      if (totalPages === null || page >= totalPages) break;
      if (page === PAGES_PER_CHAT) truncated = true;
    }

    // Evolution's chat record carries the WhatsApp profile picture URL —
    // stamp it on the chat row the ingest just created/updated. The URL
    // expires on WhatsApp's side; re-running the sweep refreshes it.
    const avatar = chat.profilePicUrl;
    if (typeof avatar === "string" && avatar) {
      const phone = resolveLidNumber?.(jid) ?? remoteNumberFor(jid);
      const update = await db
        .from("whatsapp_chats")
        .update({ avatar_url: avatar })
        .eq("chat_number", phone);
      if (update.error) throw new Error(update.error.message);
    }
  }

  return {
    chatsWalked,
    chatsSkipped,
    chatsAwaitingLid,
    messagesImported,
    contactsImported,
    complete: !truncated,
  };
}
