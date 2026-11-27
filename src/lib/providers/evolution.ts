import type { Json } from "@/integrations/supabase/database.types";
import {
  createEvolutionClient,
  extractState,
  EvolutionApiError,
  remoteNumberFor,
} from "@/lib/evolution/client";
import type { EvolutionClient, Fetcher } from "@/lib/evolution/client";
import { evolutionLocalPacer } from "@/lib/providers/evolutionLocalPacing";
import type { ProviderResult, WhatsAppProviderMessage } from "@/lib/providers/types";
import {
  assertPlatformEndpoint,
  configValue,
  DELIVERY_INDETERMINATE,
  requiredEnv,
  toInternationalDigits,
} from "@/lib/providers/types";
import { evolutionSessionDisconnectedReason } from "@/lib/whatsappSkipReasons";

/** عنوان خادم Evolution داخل شبكة المنصة كما زرعه الترحيل 178. */
const EVOLUTION_SEEDED_API_BASE = "http://evolution:8080";

/**
 * خطأ من مزوّد Evolution يحمل كوداً مُنمّطاً تقرأه مهمة التصريف.
 *
 * Mirrors PostoraProviderError's contract: only `.code` is persisted (as
 * `notifications.error_code`) and read by the drain job; `.retryable` is for
 * callers and tests. `session_disconnected` is the important one — a logged-out
 * QR session is the "retrying cannot fix this, a human must re-scan" case.
 */
export class EvolutionProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EvolutionProviderError";
  }
}

export type EvolutionStatus = {
  connectedNumber: string | null;
  state: string | null;
};

/**
 * يقرأ api_base واسم متغيّر البيئة لمفتاح Evolution من إعداد المزوّد دون كشف السر.
 */
export function resolveEvolutionCredentials(config: Json): { apiBase: string; apiKey: string } {
  const apiBase = configValue(config, "api_base");
  if (!apiBase) throw new Error("Evolution provider config is missing api_base.");
  const apiKey = requiredEnv(config, "api_key_env");
  // The key comes from the platform's environment, so it may only reach the
  // platform's Evolution server: the seeded in-network address or EVOLUTION_API_URL.
  assertPlatformEndpoint(apiBase, [EVOLUTION_SEEDED_API_BASE, process.env.EVOLUTION_API_URL]);
  return { apiBase, apiKey };
}

/**
 * يبني عميل Evolution من إعداد المزوّد؛ نقطة تجميع واحدة للاعتماديات.
 *
 * `timeoutMs` exists for callers whose work is decoration rather than
 * delivery — the avatar backfill would rather give up in seconds than hold a
 * connection for the default ten.
 */
export function evolutionClientFromConfig(
  config: Json,
  fetcher?: Fetcher,
  timeoutMs?: number,
): EvolutionClient {
  const { apiBase, apiKey } = resolveEvolutionCredentials(config);
  return createEvolutionClient({ baseUrl: apiBase, apiKey, fetcher, timeoutMs });
}

/**
 * يستخرج معرّف الرسالة من استجابة إرسال Evolution بأشكالها المتعددة.
 */
function messageIdFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { key?: { id?: unknown }; messages?: Array<{ id?: unknown }> };
  const keyId = record.key?.id;
  if (typeof keyId === "string" && keyId) return keyId;
  const firstId = record.messages?.[0]?.id;
  return typeof firstId === "string" && firstId ? firstId : null;
}

/**
 * يستعلم حالة الجلسة مرة واحدة؛ null تعني أن البوّابة نفسها لم تُجب.
 */
async function probeSessionState(
  client: EvolutionClient,
  instanceName: string,
): Promise<string | null> {
  return client
    .connectionState(instanceName)
    .then(extractState)
    .catch(() => null);
}

/**
 * يبني خطأ "الجلسة مفصولة" — غير قابل لإعادة المحاولة، يحتاج مسح QR جديداً.
 */
export function sessionDisconnectedError(state: string | null): EvolutionProviderError {
  return new EvolutionProviderError(
    evolutionSessionDisconnectedReason(state),
    "session_disconnected",
    false,
  );
}

/**
 * يصنّف فشل إرسال واحد إلى كود مُنمّط، مستعيناً بفحص حالة اتصال واحد.
 *
 * Conservative on purpose: only network-level failures and 5xx are retryable,
 * and only while the session is still paired. After a connection-class
 * failure, ONE `connectionState` probe decides between `session_disconnected`
 * (human must re-scan — needs_review) and a transient error. 4xx bodies
 * mentioning the number map to `number_not_on_whatsapp`, which no amount of
 * retrying or re-scanning fixes.
 *
 * The 5xx branch probes too. On 2026-09-02 WhatsApp unlinked the device
 * mid-batch (`stream:error 401 device_removed`); Evolution then answered every
 * send with HTTP 500 "Connection Closed", which read here as transient, burned
 * three retries per row, and parked eleven tenant messages as `failed` with a
 * reason that said the opposite of what happened. A 5xx whose probe also fails
 * stays transient — that is the gateway restarting, not the session gone.
 */
async function classifySendFailure(
  error: unknown,
  client: EvolutionClient,
  instanceName: string,
): Promise<EvolutionProviderError> {
  if (error instanceof EvolutionProviderError) return error;
  if (!(error instanceof EvolutionApiError)) {
    const message = error instanceof Error ? error.message : "Evolution send failed.";
    return new EvolutionProviderError(message, "unknown_error", true);
  }
  if (error.status === 404) {
    return new EvolutionProviderError(
      `Evolution instance "${instanceName}" does not exist (404).`,
      "instance_missing",
      false,
    );
  }
  const bodyText = JSON.stringify(error.body ?? "").toLowerCase();
  if (bodyText.includes("not") && bodyText.includes("whatsapp")) {
    return new EvolutionProviderError(
      "Evolution reports the recipient number is not on WhatsApp.",
      "number_not_on_whatsapp",
      false,
    );
  }
  const state = await probeSessionState(client, instanceName);
  if (error.status === 0 || error.status >= 500) {
    if (state !== null && state !== "open") return sessionDisconnectedError(state);
    // Status 0 is the client's own timeout, not an answer: Evolution may have
    // queued the message after we stopped waiting, and it takes no idempotency
    // key, so a drain retry could message the tenant twice.
    if (error.status === 0) {
      return new EvolutionProviderError(
        "Evolution did not answer in time; the message may have been delivered.",
        DELIVERY_INDETERMINATE,
        false,
      );
    }
    return new EvolutionProviderError(
      `Evolution send failed transiently (${error.status || "timeout"}).`,
      "unknown_error",
      true,
    );
  }
  // 4xx that is not obviously about the recipient: an unreachable probe is
  // treated as not paired — the row parks for a human rather than retrying a
  // rejection the gateway has already made.
  if (state !== "open") return sessionDisconnectedError(state);
  return new EvolutionProviderError(
    `Evolution rejected the message (${error.status}).`,
    "unknown_error",
    false,
  );
}

/**
 * يرسل إشعار واتساب عبر Evolution: نص أولاً ثم كل مرفق بالتسلسل.
 *
 * Free-text deliberately — Evolution is a Baileys bridge with no Meta template
 * layer, so `body` goes out verbatim and attachments ride as separate media
 * messages. Sequential with pacing between parts; stops at the first failing
 * part and reports how many went out, because a blind retry of the whole
 * notification would duplicate the parts that already reached the tenant
 * (that is why `partial_send` parks in needs_review, never in the retry loop).
 *
 * Pacing is the caller's to supply: WhatsApp bans numbers that send
 * back-to-back, so the notify worker takes a per-connection lock before it
 * sends (`() => pacer.waitForSlot(connectionId)`). A caller outside the
 * worker — the drain, the manual re-send, the chat composers — passes none,
 * and falls back to the in-process per-connection pacer, which holds the same
 * 1.5–3 s gap for the paths the worker lock does not cover.
 */
export async function sendWithEvolution(
  message: WhatsAppProviderMessage,
  instanceName: string,
  fetcher?: Fetcher,
  pace: () => Promise<void> = evolutionLocalPacer(instanceName),
): Promise<ProviderResult & { partIds: string[] }> {
  const client = evolutionClientFromConfig(message.config, fetcher);
  const number = toInternationalDigits(message.to);
  const body = (message.body ?? "").trim();
  const media = message.media ?? [];
  if (!body && !media.length) {
    throw new Error("Evolution requires a message body or at least one attachment.");
  }

  const partIds: string[] = [];
  const totalParts = (body ? 1 : 0) + media.length;

  const sendPart = async (send: () => Promise<unknown>): Promise<void> => {
    await pace();
    try {
      const raw = await send();
      partIds.push(messageIdFrom(raw) ?? `evo_${crypto.randomUUID()}`);
    } catch (error) {
      const classified = await classifySendFailure(error, client, instanceName);
      if (partIds.length > 0) {
        throw new EvolutionProviderError(
          `Evolution delivered ${partIds.length} of ${totalParts} message parts before failing: ${classified.message}`,
          "partial_send",
          false,
        );
      }
      throw classified;
    }
  };

  if (body) {
    await sendPart(() => client.sendText(instanceName, { number, text: body }));
  }
  for (const item of media) {
    await sendPart(() =>
      // No caption: the body already went out as its own text part, and a
      // caption would make the tenant read the same receipt summary twice.
      client.sendMedia(instanceName, {
        number,
        mediatype: item.mediatype,
        media: item.base64,
        fileName: item.fileName,
      }),
    );
  }

  return { messageId: partIds.join(","), partIds };
}

/**
 * يقرأ رقم المالك المقترن من fetchInstances (تعيد مصفوفة حتى مع الترشيح بالاسم).
 *
 * Shared by the settings status view and the QR polling fn so the two can
 * never disagree on how an owner JID becomes a phone number.
 */
export async function connectedNumberFor(
  client: EvolutionClient,
  instanceName: string,
): Promise<string | null> {
  const instances = (await client.fetchInstance(instanceName).catch(() => null)) as Array<{
    ownerJid?: unknown;
    owner?: unknown;
  }> | null;
  const owner = instances?.[0]?.ownerJid ?? instances?.[0]?.owner;
  return typeof owner === "string" && owner ? remoteNumberFor(owner) : null;
}

/**
 * يستعلم حالة اقتران النسخة ورقم المالك (قراءة فقط، للوحة الإعدادات).
 */
export async function getEvolutionStatus(
  config: Json,
  instanceName: string,
  fetcher?: Fetcher,
): Promise<EvolutionStatus> {
  const client = evolutionClientFromConfig(config, fetcher);
  const state = await client.connectionState(instanceName).then(extractState);
  const connectedNumber = state === "open" ? await connectedNumberFor(client, instanceName) : null;
  return { state, connectedNumber };
}
