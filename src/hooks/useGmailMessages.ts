import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { gmailTrashMessages } from "@/fns/gmailTrashMessages";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { pageRange } from "@/hooks/pagination";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { detectGmailDeliveryFailure, type GmailDeliveryFailure } from "@/lib/gmailDeliveryFailure";

export { detectGmailDeliveryFailure } from "@/lib/gmailDeliveryFailure";

/**
 * Gmail messages synced into the unified inbox by the Gmail sync worker
 * (src/fns/gmailSyncJob.ts).
 *
 * The list and the detail are separate queries on purpose. `raw_payload` holds
 * the entire `format=full` message — every MIME part, base64-encoded — so a
 * `select("*")` over the list drags the whole mailbox into the browser to
 * render rows that show a subject and a snippet. `body_text` is also heavy and
 * redundant with `snippet` for list rows, so the list omits both; `useGmailMessage`
 * fetches the full row for the one message being read.
 */
export type GmailMessage = Tables<"gmail_messages">;

/** Columns needed to render the inbox list (and the header-bell preview). */
export const GMAIL_LIST_COLUMNS =
  "id, company_id, message_id, thread_id, from_address, to_address, subject, snippet, failed_recipients, received_at, is_read, direction, category, provider, created_at, updated_at";

/**
 * القائمة الاحتياطية: بلا الأعمدة التي قد لا يعرفها PostgREST بعد.
 *
 * Drops `failed_recipients` (migration 138) *and* `provider` (migration 158).
 * One fallback rather than one per migration: the whole select 400s if any
 * named column is missing, so the retry has to omit every column that might not
 * be there yet. Adding a third such column means adding it here too.
 */
export const GMAIL_LIST_COLUMNS_FALLBACK =
  "id, company_id, message_id, thread_id, from_address, to_address, subject, snippet, received_at, is_read, direction, category, created_at, updated_at";

/** @deprecated Use {@link GMAIL_LIST_COLUMNS_FALLBACK}. Kept for existing imports. */
export const GMAIL_LIST_COLUMNS_PRE_138 = GMAIL_LIST_COLUMNS_FALLBACK;

/**
 * يميّز خطأ PostgREST عندما يكون أحد الأعمدة الاختيارية غير موجود بعد.
 *
 * The whole select 400s if one named column is missing, so until a migration is
 * applied the inbox must retry without that column instead of going dark. Both
 * `failed_recipients` (138) and `provider` (158) are optional in this sense:
 * schema is applied before the deploy, but a rollback or a half-applied set
 * would otherwise take the whole inbox down rather than one badge.
 */
export function isMissingOptionalColumn(error: {
  code?: string | null;
  message?: string | null;
}): boolean {
  const message = error.message ?? "";
  const code = error.code ?? "";
  if (!/failed_recipients|provider/i.test(message) && code !== "PGRST204") return false;
  return (
    code === "PGRST204" || code === "42703" || /does not exist|schema cache|column/i.test(message)
  );
}

/** @deprecated Use {@link isMissingOptionalColumn}. Kept for existing imports. */
export const isMissingFailedRecipientsColumn = isMissingOptionalColumn;

export type GmailMessageListItem = Pick<
  GmailMessage,
  | "id"
  | "company_id"
  | "message_id"
  | "thread_id"
  | "from_address"
  | "to_address"
  | "subject"
  | "snippet"
  | "failed_recipients"
  | "received_at"
  | "is_read"
  | "direction"
  | "category"
  | "provider"
  | "created_at"
  | "updated_at"
>;

export type GmailMessageDirection = "received" | "sent";

/**
 * يكتشف فشل التسليم من صف القائمة الذي لا يحمل الترويسات الكاملة.
 *
 * List rows omit `raw_payload`. Detection uses `from_address`, `snippet`,
 * and the lightweight `failed_recipients` column copied from
 * X-Failed-Recipients at sync (migration 138). The open sheet still
 * re-reads the header from the full payload.
 */
export function listItemDeliveryFailure(
  item: Pick<GmailMessageListItem, "from_address" | "snippet" | "failed_recipients">,
): GmailDeliveryFailure {
  return detectGmailDeliveryFailure({
    fromAddress: item.from_address,
    snippet: item.snippet,
    failedRecipientsHeader: item.failed_recipients,
  });
}

/** المزوّد الذي حمل الرسالة. */
export type MailboxProvider = "gmail" | "resend";

export interface GmailMessageListParams {
  /** App-local category value; omit or null for all. */
  category?: string | null;
  /** Provider that carried the message; omit or null for all. */
  provider?: MailboxProvider | null;
  /**
   * Migration 100 — filter Received / Sent. `received` also matches null so
   * pre-backfill or mid-deploy rows still appear under Received.
   */
  direction?: GmailMessageDirection | null;
  /** When set, filters by `is_read`. Used by the header bell for unread previews. */
  isRead?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface GmailMessageListResult {
  items: GmailMessageListItem[];
  count: number;
}

/**
 * يبني مفتاح التخزين المؤقّت لصفحة من الرسائل.
 *
 * Every filter belongs in the key. A filter left out lets two different result
 * sets share one cache entry, which surfaces as the wrong messages appearing
 * under a filter rather than as an error.
 */
export function gmailMessagesQueryKey(
  params: Required<Pick<GmailMessageListParams, "page" | "pageSize" | "search">> & {
    category: string | null;
    direction: GmailMessageDirection | null;
    isRead: boolean | null;
    provider: MailboxProvider | null;
  },
) {
  // `direction` is part of the key so Received and Sent never share a cache page.
  return ["gmail-messages", params] as const;
}

export function useGmailMessages(params: GmailMessageListParams = {}, enabled = true) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, params.pageSize ?? 20);
  const search = params.search ?? "";
  const category = params.category ?? null;
  const direction = params.direction ?? null;
  const isRead = typeof params.isRead === "boolean" ? params.isRead : null;
  const provider = params.provider ?? null;

  return useQuery({
    // `provider` belongs in the key for the same reason `direction` does: a
    // filtered page and an unfiltered one must never share a cache entry.
    queryKey: gmailMessagesQueryKey({
      page,
      pageSize,
      search,
      category,
      direction,
      isRead,
      provider,
    }),
    enabled,
    placeholderData: (previous) => previous,
    // Inbox + header bell should notice rows the cron (or Sync now) just wrote
    // without requiring a full navigation. 30s is light on PostgREST and short
    // enough that mail appears soon after a 10-minute sync tick.
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<GmailMessageListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let query = supabase
        .from("gmail_messages")
        .select(GMAIL_LIST_COLUMNS, { count: "exact" })
        .order("received_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (category) query = query.eq("category", category);
      if (provider) query = query.eq("provider", provider);
      if (isRead !== null) query = query.eq("is_read", isRead);
      const term = normalizePostgrestSearch(search);
      const searchOr = term
        ? `subject.ilike.%${term}%,from_address.ilike.%${term}%,snippet.ilike.%${term}%,to_address.ilike.%${term}%`
        : null;
      // Direction and search both need PostgREST `or` groups. Stacking two
      // `.or()` calls is fragile (duplicate query keys); combine into one when
      // both apply. Null direction is treated as received (pre-backfill rows).
      // Syntax matches useTenants / scheduledReportsJob for the null branch.
      if (direction === "sent") {
        query = query.eq("direction", "sent");
        if (searchOr) query = query.or(searchOr);
      } else if (direction === "received") {
        if (searchOr) {
          query = query.or(
            `and(direction.eq.received,or(${searchOr})),and(direction.is.null,or(${searchOr}))`,
          );
        } else {
          query = query.or("direction.eq.received,direction.is.null");
        }
      } else if (searchOr) {
        query = query.or(searchOr);
      }
      let { data, error, count } = await query;
      if (error && isMissingOptionalColumn(error)) {
        let fallback = supabase
          .from("gmail_messages")
          .select(GMAIL_LIST_COLUMNS_FALLBACK, { count: "exact" })
          .order("received_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
        if (category) fallback = fallback.eq("category", category);
        if (isRead !== null) fallback = fallback.eq("is_read", isRead);
        if (direction === "sent") {
          fallback = fallback.eq("direction", "sent");
          if (searchOr) fallback = fallback.or(searchOr);
        } else if (direction === "received") {
          if (searchOr) {
            fallback = fallback.or(
              `and(direction.eq.received,or(${searchOr})),and(direction.is.null,or(${searchOr}))`,
            );
          } else {
            fallback = fallback.or("direction.eq.received,direction.is.null");
          }
        } else if (searchOr) {
          fallback = fallback.or(searchOr);
        }
        const retried = await fallback;
        data = retried.data as typeof data;
        error = retried.error;
        count = retried.count;
      }
      if (error) throw error;
      return {
        items: ((data ?? []) as unknown as GmailMessageListItem[]).map((item) => ({
          ...item,
          failed_recipients: item.failed_recipients ?? null,
        })),
        count: count ?? 0,
      };
    },
  });
}

/** The full message, fetched only while one is open. */
export function useGmailMessage(id: string | null) {
  return useQuery({
    queryKey: ["gmail-message", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<GmailMessage | null> => {
      const { data, error } = await supabase
        .from("gmail_messages")
        .select("*")
        .eq("id", id as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as GmailMessage | null;
    },
  });
}

/**
 * Moves messages to Trash in Gmail, then removes the local rows.
 *
 * The previous version deleted the local row only, so the next sync tick pulled
 * every "deleted" message back in.
 *
 * Partial results are returned rather than thrown: some messages may be trashed
 * while others fail, and the caller has to be able to report both.
 * Invalidation happens in `onSettled` for the same reason.
 */
export function useTrashGmailMessages() {
  const queryClient = useQueryClient();
  const trash = useServerFn(gmailTrashMessages);
  return useMutation({
    mutationFn: async (
      ids: string[],
    ): Promise<{ trashed: number; failed: Array<{ id: string; reason: string }> }> => {
      if (!ids.length) return { trashed: 0, failed: [] };
      const result = (await trash({ data: { ids } })) as
        | { trashed?: number; failed?: Array<{ id: string; reason: string }> }
        | undefined;
      // A thrown Response resolves here instead of rejecting, so the shape is
      // checked rather than assumed.
      if (typeof result?.trashed !== "number") {
        throw new Error("Gmail did not confirm the messages were deleted.");
      }
      return { trashed: result.trashed, failed: result.failed ?? [] };
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["gmail-messages"] });
      queryClient.invalidateQueries({ queryKey: ["gmail-message"] });
    },
  });
}

export function useMarkGmailRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isRead }: { id: string; isRead: boolean }) => {
      const { error } = await supabase
        .from("gmail_messages")
        .update({ is_read: isRead, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["gmail-messages"] });
      queryClient.invalidateQueries({ queryKey: ["gmail-message", variables.id] });
    },
  });
}

/**
 * Assigns the app-local category (migration 62). Null clears it.
 *
 * Staff already hold row-level UPDATE on `gmail_messages` for mark-read, and
 * that policy carries no column list, so this needs no new grant.
 */
export function useSetGmailCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, category }: { id: string; category: string | null }) => {
      const { error } = await supabase
        .from("gmail_messages")
        .update({ category, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["gmail-messages"] });
      queryClient.invalidateQueries({ queryKey: ["gmail-message", variables.id] });
    },
  });
}
