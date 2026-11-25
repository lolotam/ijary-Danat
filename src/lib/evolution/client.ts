/**
 * عميل مشترك لواجهة Evolution API (بوّابة واتساب ذاتية الاستضافة عبر Baileys).
 *
 * Single home for every HTTP call the app makes to the Evolution container, so
 * the provider adapter, the QR session server fns and the webhook code share
 * one auth header, one timeout and one error shape. The `fetcher` parameter is
 * injectable so tests never need a network. Written against Evolution v2.3.7
 * behaviour — version-specific quirks are documented inline where they bite.
 */

export type Fetcher = typeof fetch;

export interface EvolutionClientOptions {
  /** Base URL of the Evolution container, no trailing slash required. */
  baseUrl: string;
  /** Global API key, sent as the `apikey` header on every request. */
  apiKey: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/**
 * خطأ من Evolution يحمل رمز الحالة وجسم الاستجابة للتشخيص.
 *
 * `.status` drives classification upstream (the provider adapter maps it to a
 * persisted `error_code`); `.body` is kept for diagnostics but must never be
 * logged verbatim — it can carry phone numbers.
 */
export class EvolutionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "EvolutionApiError";
  }
}

export interface EvolutionWebhookConfig {
  url: string;
  headers: Record<string, string>;
  events: string[];
}

export interface EvolutionMediaInput {
  number: string;
  mediatype: "image" | "video" | "document" | "audio";
  /** Base64 payload or a URL Evolution can fetch. */
  media: string;
  caption?: string;
  fileName?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * يبني عميل Evolution بواجهات الإصدار الأول فقط (لا مزامنة تاريخ بعد).
 *
 * Only the endpoints v1 actually uses ship here; findChats/findContacts/
 * findMessages arrive with the history-sync follow-up so unused surface does
 * not accrete review burden.
 */
export function createEvolutionClient(options: EvolutionClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * ينفّذ طلباً موحّداً مع مهلة وإلغاء، ويرمي EvolutionApiError عند الفشل.
   *
   * The abort timer covers the body read too: Evolution occasionally accepts
   * the socket and then stalls, and a hung `response.json()` blocks a cron
   * dispatch batch just as badly as a hung connect.
   */
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        headers: {
          apikey: apiKey,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new EvolutionApiError(
          `Evolution API request failed with status ${response.status}`,
          response.status,
          body,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new EvolutionApiError("Evolution API request timed out", 0, null);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * ينشئ نسخة واتساب جديدة مع إعداد الويبهوك في نفس الطلب.
     */
    createInstance(input: { instanceName: string; webhook: EvolutionWebhookConfig }) {
      return request("/instance/create", {
        method: "POST",
        body: JSON.stringify({
          instanceName: input.instanceName,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
          webhook: {
            enabled: true,
            url: input.webhook.url,
            webhookByEvents: false,
            webhookBase64: false,
            headers: input.webhook.headers,
            events: input.webhook.events,
          },
        }),
      });
    },

    /**
     * يعيد ضبط ويبهوك نسخة قائمة (يُستخدم عندما تكون النسخة موجودة مسبقاً).
     */
    setWebhook(instanceName: string, webhook: EvolutionWebhookConfig) {
      return request(`/webhook/set/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          webhook: {
            enabled: true,
            url: webhook.url,
            webhookByEvents: false,
            webhookBase64: false,
            headers: webhook.headers,
            events: webhook.events,
          },
        }),
      });
    },

    /**
     * يطلب رمز QR جديداً (أو حالة الاتصال إن كانت النسخة متصلة بالفعل).
     */
    connect(instanceName: string) {
      return request(`/instance/connect/${encodeURIComponent(instanceName)}`);
    },

    /**
     * يستعلم حالة اتصال النسخة (`open` تعني مقترنة وجاهزة للإرسال).
     */
    connectionState(instanceName: string) {
      return request(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
    },

    /**
     * يجلب بيانات النسخة (تُستخدم لقراءة رقم المالك بعد الاقتران).
     *
     * Evolution returns an array even when filtered by name; callers take [0].
     */
    fetchInstance(instanceName: string) {
      return request(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
    },

    /**
     * يسجّل خروج النسخة من واتساب دون حذفها.
     */
    logout(instanceName: string) {
      return request(`/instance/logout/${encodeURIComponent(instanceName)}`, {
        method: "DELETE",
      });
    },

    /**
     * يحذف النسخة نهائياً من خادم Evolution.
     */
    deleteInstance(instanceName: string) {
      return request(`/instance/delete/${encodeURIComponent(instanceName)}`, {
        method: "DELETE",
      });
    },

    /**
     * يرسل رسالة نصية حرة؛ الرقم أرقام دولية مجردة و Evolution يضيف لاحقة JID بنفسه.
     */
    sendText(instanceName: string, input: { number: string; text: string }) {
      return request(`/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    /**
     * يرسل وسائط (صورة/مستند/فيديو/صوت) مع تسمية اختيارية.
     */
    sendMedia(instanceName: string, input: EvolutionMediaInput) {
      return request(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    /**
     * يجلب وسائط رسالة واردة كـ base64 — Evolution يسلّم البايتات عبر واجهته
     * الخاصة وليس عبر رابط قابل للتنزيل.
     */
    getBase64FromMediaMessage(instanceName: string, messageId: string) {
      return request(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ message: { key: { id: messageId } }, convertToMp4: false }),
      });
    },

    /**
     * يسرد المحادثات المخزّنة لدى Evolution (لمزامنة التاريخ بعد الاقتران).
     */
    findChats(instanceName: string) {
      return request(`/chat/findChats/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: "{}",
      });
    },

    /**
     * يسرد جهات الاتصال المخزّنة. المسار تحت `/chat/` وليس `/contact/` —
     * الأخير يعيد 404 على الإصدار 2.3.7.
     */
    findContacts(instanceName: string) {
      return request(`/chat/findContacts/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: "{}",
      });
    },

    /**
     * يجلب رابط صورة الملف الشخصي لرقم واحد كما تعرضه واتساب الآن.
     *
     * findChats/findContacts only carry `profilePicUrl` for the contacts
     * Evolution happened to have cached at pairing — 4 of 43 chats on
     * production — so a per-number lookup is the only way to fill the rest.
     * A number with no picture, or one whose privacy settings hide it, answers
     * with no URL rather than an error; callers treat that as "none".
     */
    fetchProfilePictureUrl(instanceName: string, number: string) {
      return request(`/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ number }),
      });
    },

    /**
     * يحذف رسالة للجميع عبر واتساب (revoke) — يظهر "تم حذف هذه الرسالة" لدى الطرف الآخر.
     */
    deleteMessageForEveryone(
      instanceName: string,
      input: { id: string; remoteJid: string; fromMe?: boolean },
    ) {
      return request(`/chat/deleteMessageForEveryone/${encodeURIComponent(instanceName)}`, {
        method: "DELETE",
        body: JSON.stringify({
          id: input.id,
          remoteJid: input.remoteJid,
          fromMe: input.fromMe ?? true,
        }),
      });
    },

    /**
     * يجلب صفحة من رسائل محادثة واحدة (انظر collectMessagePage لفكّ الأشكال).
     */
    findMessages(instanceName: string, input: { remoteJid: string; page: number }) {
      return request(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          page: input.page,
          offset: 50,
          where: { key: { remoteJid: input.remoteJid } },
        }),
      });
    },
  };
}

export type EvolutionClient = ReturnType<typeof createEvolutionClient>;

/**
 * يوحّد اسم حدث الويبهوك: الاشتراك يسجَّل بصيغة SCREAMING_SNAKE لكن الجسم
 * المُسلَّم يستخدم `connection.update` — فتُطبَّع النقاط والشرطات قبل المقارنة.
 */
export function normalizeEvolutionEvent(event: unknown): string {
  return String(event ?? "")
    .replace(/[.-]/g, "_")
    .toUpperCase();
}

export interface EvolutionMessagePage {
  records: unknown[];
  /** null = the deployment returned a bare array, which IS the complete set. */
  totalPages: number | null;
}

/**
 * يفكّ استجابة findMessages بأشكالها: مغلّف مُرقَّم أو مصفوفة مجردة.
 *
 * v2.3.7 returns `{ messages: { records, pages } }` and caps a page at ~40
 * rows regardless of the requested offset — so `pages` is the terminator, NOT
 * a short page (stopping on "fewer than asked" loops the same rows). Some
 * deployments instead return a bare array; that is the complete result
 * immediately, otherwise pages 2..n would re-accumulate the same rows.
 */
export function collectMessagePage(payload: unknown): EvolutionMessagePage {
  if (Array.isArray(payload)) return { records: payload, totalPages: null };
  const envelope = asRecord(asRecord(payload)?.messages);
  const records = Array.isArray(envelope?.records) ? envelope.records : [];
  const pages = Number(envelope?.pages);
  return { records, totalPages: Number.isFinite(pages) && pages > 0 ? pages : 1 };
}

/**
 * يستخرج رمز QR من استجابة connect بأشكالها المتعددة عبر إصدارات Evolution.
 */
export function extractQr(payload: unknown): string | null {
  const record = asRecord(payload);
  const qr = asRecord(record?.qrcode) ?? asRecord(record?.qr) ?? record;
  const value = qr?.base64 ?? qr?.image ?? qr?.code;
  return typeof value === "string" && value ? value : null;
}

/**
 * يستخرج حالة الاتصال من استجابات connect/connectionState المتفاوتة الشكل.
 */
export function extractState(payload: unknown): string | null {
  const record = asRecord(payload);
  const instance = asRecord(record?.instance);
  const value = instance?.state ?? record?.state ?? record?.connectionStatus;
  return typeof value === "string" && value ? value : null;
}

/**
 * يحوّل JID إلى رقم مجرد، مع إسقاط لاحقة الجهاز قبل إسقاط غير الأرقام.
 *
 * Multi-device JIDs carry a ":<device>" component, e.g.
 * "96597950350:12@s.whatsapp.net". Stripping every non-digit first would
 * splice the device number onto the subscriber number and fabricate a phone
 * number that then flows into the conversation id.
 */
export function remoteNumberFor(remoteJid: string): string {
  const local = remoteJid.split("@")[0].split(":")[0];
  return local.replace(/\D/g, "") || remoteJid;
}

/**
 * يحلّ JID القابل للمراسلة: يقبل أرقام `@s.whatsapp.net` مباشرة، ويحلّ `@lid`
 * عبر `remoteJidAlt`، ويرفض المجموعات والقنوات والحالات.
 *
 * Evolution normalises the live webhook payload to the phone JID but stores
 * historical records under the LID; resolving both to the same phone JID keeps
 * one conversation per contact instead of two.
 */
export function addressableJid(key: unknown): string | null {
  const record = asRecord(key);
  const remoteJid = String(record?.remoteJid ?? "");
  if (remoteJid.endsWith("@s.whatsapp.net")) return remoteJid;
  if (!remoteJid.endsWith("@lid")) return null;
  const alternate = String(record?.remoteJidAlt ?? "");
  return alternate.endsWith("@s.whatsapp.net") ? alternate : null;
}

/**
 * يخفي رقم الهاتف في السجلات مبقياً آخر أربعة أرقام فقط.
 */
export function maskJid(jid: string): string {
  const digits = remoteNumberFor(jid);
  return digits.length > 4 ? `…${digits.slice(-4)}` : "…";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
