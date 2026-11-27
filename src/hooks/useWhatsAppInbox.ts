import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { useInViewOnce } from "./useInViewOnce";
import { useObjectUrl } from "./useObjectUrl";

export { useInViewOnce, useObjectUrl };
// Re-exported rather than moved: ~15 components import the contacts hooks from
// this module, and a rename of the import path is churn that buys nothing.
export * from "./useWhatsAppContactsData";

import {
  deleteWhatsAppChat,
  deleteWhatsAppMessage,
  exportWhatsAppContactsCsv,
  markWhatsAppChatRead,
  sendWhatsAppChatMessage,
} from "@/fns/whatsappChat";
import {
  downloadWhatsAppMedia,
  forwardWhatsAppMessage,
  sendWhatsAppChatMedia,
} from "@/fns/whatsappMedia";
import { supabase } from "@/integrations/supabase/client";
import { sessionHeaders, useActiveWhatsAppConnectionId } from "./whatsappSession";
import type {
  Database,
  WhatsappChatRow,
  WhatsappMessageRow,
} from "@/integrations/supabase/database.types";

/**
 * حِزم بيانات صندوق واتساب: قائمة المحادثات، خيط الرسائل، وجهات الاتصال.
 *
 * No Realtime exists in this app, so freshness is polling: the chat list every
 * 15s, the newest page of the open thread every 5s while the tab is visible
 * (paused when hidden), history pages on demand with a compound (sent_at, id)
 * keyset cursor — sent_at alone is not unique and would skip or duplicate
 * rows across page boundaries.
 */

const THREAD_PAGE_SIZE = 40;

/** Polls only while the browser tab is visible. */
function visiblePollInterval(ms: number): () => number | false {
  return () =>
    typeof document !== "undefined" && document.visibilityState === "visible" ? ms : false;
}

/**
 * يجلب قائمة محادثات واتساب مقيّدة بمعرّف الاتصال النشط للشركة مع دمج أسماء الدليل.
 */
export async function fetchWhatsAppChats(
  client: SupabaseClient<Database>,
  connectionId: string | null,
  search: string,
): Promise<WhatsappChatRow[]> {
  if (!connectionId) return [];

  let query = client
    .from("whatsapp_chats")
    .select("*")
    .eq("connection_id", connectionId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (search.trim()) {
    const term = search.trim().replace(/[%_]/g, "");
    query = query.or(`chat_number.ilike.%${term}%,display_name.ilike.%${term}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const chats = data ?? [];
  if (!chats.length) return chats;

  // The contact directory is the authoritative name book: a name the admin
  // typed there beats the WhatsApp push name captured at ingest (which for
  // LID accounts is often just digits). chat_number === contacts.phone.
  const contacts = await client
    .from("whatsapp_contacts")
    .select("phone, name, avatar_url")
    .eq("connection_id", connectionId)
    .in(
      "phone",
      chats.map((chat) => chat.chat_number),
    );
  if (contacts.error) throw contacts.error;
  const byPhone = new Map((contacts.data ?? []).map((contact) => [contact.phone, contact]));
  return chats.map((chat) => {
    const contact = byPhone.get(chat.chat_number);
    return {
      ...chat,
      display_name: contact?.name?.trim() ? contact.name : chat.display_name,
      avatar_url: chat.avatar_url ?? contact?.avatar_url ?? null,
    };
  });
}

/**
 * يستعلم عن قائمة محادثات واتساب للاتصال النشط للشركة.
 */
export function useWhatsAppChats(enabled: boolean, search: string) {
  const connectionQuery = useActiveWhatsAppConnectionId(enabled);
  const connectionId = connectionQuery.data ?? null;
  return useQuery({
    queryKey: ["whatsapp-chats", search, connectionId],
    enabled: enabled && connectionQuery.isFetched,
    refetchInterval: visiblePollInterval(15_000),
    queryFn: () => fetchWhatsAppChats(supabase, connectionId, search),
  });
}

type MessageCursor = { sentAt: string; id: string };

/**
 * يجلب صفحة رسائل لمحادثة محددة مقيّدة بمعرّف الاتصال النشط.
 */
export async function fetchWhatsAppMessagesPage(
  client: SupabaseClient<Database>,
  connectionId: string | null,
  chatNumber: string,
  cursor: MessageCursor | null = null,
): Promise<WhatsappMessageRow[]> {
  if (!connectionId) return [];

  let query = client
    .from("whatsapp_messages")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("chat_number", chatNumber)
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(THREAD_PAGE_SIZE);
  if (cursor) {
    query = query.or(
      `sent_at.lt.${cursor.sentAt},and(sent_at.eq.${cursor.sentAt},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * خيط محادثة واحدة: أحدث صفحة تُستطلع كل 5 ثوانٍ، والتاريخ يُسحب عند الطلب،
 * ويُدمجان بلا تكرار عبر معرّف الرسالة.
 */
export function useWhatsAppThread(chatNumber: string | null) {
  const connectionQuery = useActiveWhatsAppConnectionId(!!chatNumber);
  const connectionId = connectionQuery.data ?? null;
  const threadReady = !!chatNumber && connectionQuery.isFetched;

  const latest = useQuery({
    queryKey: ["whatsapp-latest", chatNumber, connectionId],
    enabled: threadReady,
    refetchInterval: visiblePollInterval(5_000),
    queryFn: () => fetchWhatsAppMessagesPage(supabase, connectionId, chatNumber!),
  });

  const history = useInfiniteQuery({
    queryKey: ["whatsapp-history", chatNumber, connectionId],
    enabled: threadReady,
    refetchInterval: false,
    initialPageParam: null as MessageCursor | null,
    queryFn: ({ pageParam }) =>
      fetchWhatsAppMessagesPage(supabase, connectionId, chatNumber!, pageParam),
    getNextPageParam: (lastPage): MessageCursor | null | undefined => {
      if (lastPage.length < THREAD_PAGE_SIZE) return undefined;
      const oldest = lastPage[lastPage.length - 1];
      return { sentAt: oldest.sent_at, id: oldest.id };
    },
  });

  // Merge latest + history, dedupe by message_id, ascending for rendering.
  const messages = useMemo(() => {
    const byId = new Map<string, WhatsappMessageRow>();
    for (const page of history.data?.pages ?? []) {
      for (const row of page) byId.set(row.message_id, row);
    }
    for (const row of latest.data ?? []) byId.set(row.message_id, row);
    return [...byId.values()].sort(
      (a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id),
    );
  }, [history.data, latest.data]);

  return {
    messages,
    isLoading: latest.isLoading,
    error: latest.error ?? history.error,
    hasOlder: history.hasNextPage ?? true,
    loadOlder: () => history.fetchNextPage(),
    isLoadingOlder: history.isFetchingNextPage,
  };
}

export function useSendWhatsAppMessage(chatNumber: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      if (!chatNumber) throw new Error("No chat selected.");
      const headers = await sessionHeaders();
      return sendWhatsAppChatMessage({ data: { chatNumber, body }, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-latest", chatNumber] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}

export function useMarkWhatsAppChatRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { chatNumber: string; seenAt: string }) => {
      const headers = await sessionHeaders();
      return markWhatsAppChatRead({ data: input, headers });
    },
    onMutate: async ({ chatNumber }) => {
      await queryClient.cancelQueries({ queryKey: ["whatsapp-chats"] });
      const previous = new Map<unknown, unknown>();
      const queries = queryClient.getQueryCache().findAll({ queryKey: ["whatsapp-chats"] });
      for (const query of queries) {
        previous.set(query.queryKey, query.state.data);
        const data = query.state.data as WhatsappChatRow[] | undefined;
        if (Array.isArray(data)) {
          queryClient.setQueryData(
            query.queryKey,
            data.map((chat) =>
              chat.chat_number === chatNumber ? { ...chat, unread_count: 0 } : chat,
            ),
          );
        }
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous.entries()) {
          queryClient.setQueryData(key as never, data as never);
        }
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] }),
  });
}

/**
 * يحذف رسالة واحدة — محلياً أو على واتساب أيضاً.
 */
export function useDeleteWhatsAppMessage(chatNumber: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { messageId: string; mode: "forMe" | "forEveryone" }) => {
      const headers = await sessionHeaders();
      return deleteWhatsAppMessage({ data: input, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-latest", chatNumber] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-history", chatNumber] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}

/**
 * يحذف خيط محادثة (رسائله وصفّه)؛ جهة الاتصال تبقى.
 */
export function useDeleteWhatsAppChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (chatNumber: string) => {
      const headers = await sessionHeaders();
      return deleteWhatsAppChat({ data: { chatNumber }, headers });
    },
    onSuccess: (_result, chatNumber) => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
      void queryClient.removeQueries({ queryKey: ["whatsapp-latest", chatNumber] });
      void queryClient.removeQueries({ queryKey: ["whatsapp-history", chatNumber] });
    },
  });
}

/** يحوّل base64 إلى ملف يحفظه المتصفح. */
function saveBase64File(base64: string, fileName: string, mimeType: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * يحوّل base64 إلى Blob مصنّف — نواة خط الأنابيب الموحّد.
 *
 * نقلنا الصور من data:URL إلى Blob لأن <video> لا يقدّم seeking موثوقاً
 * على data:URL ولأن سلسلة base64 لملف 10MB تزن ~13MB وتبقى pinned في
 * ذاكرة React Query إلى الأبد. التحويل هنا هو نفسه المستخدم في blobUtils
 * لكنه مكرر لتجنب استيراد متقاطع بين hooks و components.
 */
function base64ToBlobInline(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes as unknown as BlobPart], { type: mimeType || "application/octet-stream" });
}

export interface WhatsAppMediaBlob {
  blob: Blob;
  mimeType: string;
  fileName: string;
}

/**
 * يجلب مرفق رسالة كـ Blob مصنّف، يُستخدم لكل أنواع الوسائط.
 *
 * يستبدل useWhatsAppImagePreview القديم الذي كان يبني data:URL ويُبقيها
 * في الكاش؛ هذا الخط يبقي Blob خفيفاً ويترك إنشاء object URL للمكوّن.
 * المفتاح ["whatsapp-media", messageId] يضمن كاشاً واحداً لكل رسالة.
 */
export function useWhatsAppMediaBlob(messageId: string, enabled: boolean) {
  return useQuery<WhatsAppMediaBlob>({
    queryKey: ["whatsapp-media", messageId],
    enabled,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<WhatsAppMediaBlob> => {
      const headers = await sessionHeaders();
      const media = await downloadWhatsAppMedia({ data: { messageId }, headers });
      const blob = base64ToBlobInline(media.base64, media.mimeType);
      return { blob, mimeType: media.mimeType, fileName: media.fileName };
    },
  });
}

/**
 * يجلب صورة رسالة كـ data URL لمعاينتها داخل الفقاعة تلقائياً.
 *
 * @deprecated استخدم useWhatsAppMediaBlob + useObjectUrl بدلاً منه — بُقي
 * للتوافق فقط. الصور الجديدة تمر عبر خط الأنابيب الموحّد بالـ Blobs.
 *
 * staleTime Infinity: the image bytes of a sent message never change, and the
 * server caches them in the whatsapp-media bucket — refetching would only
 * repeat the same download.
 */
export function useWhatsAppImagePreview(messageId: string, enabled: boolean) {
  return useQuery<string>({
    queryKey: ["whatsapp-image", messageId],
    enabled,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<string> => {
      const headers = await sessionHeaders();
      const media = await downloadWhatsAppMedia({ data: { messageId }, headers });
      return `data:${media.mimeType};base64,${media.base64}`;
    },
  });
}

/**
 * ينزّل مرفق رسالة إلى جهاز المستخدم (من المخزن أو من Evolution عند أول طلب).
 */
export function useDownloadWhatsAppMedia() {
  return useMutation({
    mutationFn: async (messageId: string) => {
      const headers = await sessionHeaders();
      const media = await downloadWhatsAppMedia({ data: { messageId }, headers });
      saveBase64File(media.base64, media.fileName, media.mimeType);
      return { fileName: media.fileName };
    },
  });
}

/**
 * يرسل ملفاً من الملحن؛ القارئ في المتصفح يتكفل بالتحويل إلى base64.
 */
export function useSendWhatsAppMedia(chatNumber: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!chatNumber) throw new Error("No chat selected.");
      const buffer = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      // Chunked conversion: String.fromCharCode(...whole file) overflows the
      // argument limit on files past a few hundred KB.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const headers = await sessionHeaders();
      return sendWhatsAppChatMedia({
        data: {
          chatNumber,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          base64: btoa(binary),
        },
        headers,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-latest", chatNumber] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}

/**
 * يعيد توجيه رسالة إلى محادثة أخرى.
 */
export function useForwardWhatsAppMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { messageId: string; toChatNumber: string }) => {
      const headers = await sessionHeaders();
      return forwardWhatsAppMessage({ data: input, headers });
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-latest", input.toChatNumber] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}

/**
 * يصدّر كل جهات الاتصال ويُنزّلها كملف CSV من المتصفح.
 */
export function useExportWhatsAppContacts() {
  return useMutation({
    mutationFn: async () => {
      const headers = await sessionHeaders();
      const { csv, count } = await exportWhatsAppContactsCsv({ headers });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `whatsapp-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      return { count };
    },
  });
}
