import { dispatchNotificationRecord } from "@/fns/dispatchNotification";
import { loadTemplateChannel, templateAllowsChannel } from "@/fns/templateChannelPolicy";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  Json,
  LocaleCode,
  NotificationAudience,
  NotificationChannel,
  NotificationType,
  Tables,
  TablesInsert,
} from "@/integrations/supabase/database.types";
import { isTenantBoundAudience, TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

export interface EnqueueNotificationInput {
  audience?: NotificationAudience;
  body?: string | null;
  /**
   * Skips the template-channel gate for account provisioning only.
   *
   * Credential mail is not a notification preference: a `user-credentials`
   * template set to WhatsApp-only would otherwise leave every new account
   * unable to sign in, with nothing on screen explaining why. Set it nowhere
   * else — a sender that merely wants to ignore the admin's channel choice is
   * the bug this gate exists to stop.
   */
  bypassTemplateChannel?: boolean;
  channel: NotificationChannel;
  contractId?: string | null;
  dispatch?: boolean;
  deliveryKey?: string | null;
  invoiceId?: string | null;
  locale?: LocaleCode;
  payload?: Json;
  recipientAddress?: string | null;
  reportScheduleId?: string | null;
  scheduledAt?: string | null;
  senderAddress?: string | null;
  subject?: string | null;
  templateCode?: string | null;
  tenantId?: string | null;
  type: NotificationType;
}

/**
 * ينشئ صف إشعار — ما لم تكن قناة القالب النشط تمنع هذه القناة — ويُرسله فوراً.
 *
 * Returns null when an active template excludes `input.channel`, so the row is
 * never created. The Notification Log is a user-facing audit surface: a
 * `skipped` WhatsApp row for a template the admin set to Email-only is the
 * complaint, not evidence.
 *
 * This is a backstop, not the primary mechanism. A sender that can address more
 * than one channel should consult `loadTemplateCopy(...).channel` and never call
 * this for an excluded channel, so it does not count a dropped row as queued.
 * The gate exists because the senders that only ever send email pass no channel
 * decision of their own, and because the next sender someone writes will forget.
 *
 * Prefer one row per channel for accurate Notification Log filters.
 */
export async function enqueueNotification(
  input: EnqueueNotificationInput,
): Promise<Tables<"notifications"> | null> {
  if (input.templateCode && !input.bypassTemplateChannel) {
    const templateChannel = await loadTemplateChannel(input.templateCode);
    if (!templateAllowsChannel(templateChannel, input.channel)) return null;
  }

  // The row's send time, resolved before the row is built so the pause check
  // below and the dispatch at the end of this function judge the same moment.
  const scheduledAt = input.scheduledAt ?? new Date().toISOString();

  // A row goes out now only when the caller asked for a dispatch and its
  // scheduled time sits inside the same five-second window the dispatch at
  // the end of this function uses.
  const sendsNow =
    input.dispatch !== false && new Date(scheduledAt).getTime() <= Date.now() + 5_000;

  // Owner decision 2026-10-20: a paused tenant receives nothing
  // through this pipeline, automatic or manual. The row is still created — as
  // `skipped` — so the Notification Log shows what was held back instead of
  // leaving a hole in the trail.
  //
  // Only a row that is sent NOW may be born skipped. A row the caller will
  // dispatch itself, or one scheduled for later, is not sent yet: unpausing
  // the tenant before its time comes must still deliver it, and the guard in
  // `dispatchNotificationRecord` reads the switch at that moment. Marking
  // such a row skipped here would drop a message nobody refused — so the
  // tenant is not even read for it.
  const paused =
    sendsNow && isTenantBoundAudience(input.audience) && input.tenantId
      ? await tenantNotificationsPaused(input.tenantId)
      : false;

  const row: TablesInsert<"notifications"> = {
    audience: input.audience ?? "tenant",
    body: input.body ?? null,
    channel: input.channel,
    contract_id: input.contractId ?? null,
    delivery_key: input.deliveryKey ?? null,
    failure_reason: paused ? TENANT_PAUSED_REASON : null,
    invoice_id: input.invoiceId ?? null,
    locale: input.locale ?? "ar",
    payload: input.payload ?? {},
    recipient_address: input.recipientAddress ?? null,
    report_schedule_id: input.reportScheduleId ?? null,
    scheduled_at: scheduledAt,
    sender_address: input.senderAddress ?? null,
    state: paused ? "skipped" : "queued",
    subject: input.subject ?? null,
    template_code: input.templateCode ?? null,
    tenant_id: input.tenantId ?? null,
    type: input.type,
  };

  const insertResult = await supabaseAdmin.from("notifications").insert(row).select("*").single();
  if (insertResult.error) {
    if (input.deliveryKey && insertResult.error.code === "23505") {
      // المفتاح الفريد رفض صفاً ثانياً بنفسه — فالتسليم موجود أصلاً.
      //
      // تُقرأ كل الصفوف التي تحمل المفتاح نفسه في لقطة واحدة، ثم يُختار الصف
      // في الكود: صف `queued` أو `sent` هو التسليم نفسه، وإلا فأحدث صف من
      // الصفوف القابلة للشحن.
      //
      // One snapshot, one choice. The old code read two snapshots — first
      // `queued`/`sent`, then `failed`/`needs_review`/`skipped` — and a row
      // that moved from `failed` to `sent` between them was missed by both, so
      // the duplicate surfaced as a false 23505. One read cannot straddle a
      // state change.
      //
      // A queued or sent row is the delivery itself, so it wins: the
      // contract-expiry index only covers those two states, and that job can
      // leave newer failed or skipped rows under the same key, which must not
      // be mistaken for the delivery. Only when none exists is the refusing
      // row one of the other dispatchable states that the payment index
      // (migration 251) also covers — the FAILED row the drain job will
      // retry, or the SKIPPED row a paused tenant receives once unpaused —
      // and returning it makes that dispatch reuse the existing row instead
      // of a second row being created next to it.
      //
      // No cap: rows per key are few — one payment row under index 251, one contract-expiry row per day.
      const existing = await supabaseAdmin
        .from("notifications")
        .select("*")
        .eq("delivery_key", input.deliveryKey)
        .in("state", ["queued", "sent", "failed", "needs_review", "skipped"])
        .order("created_at", { ascending: false });
      if (existing.error) throw new Error(existing.error.message);
      const found = pickExistingDelivery(existing.data ?? []);
      if (found) return found;
    }
    throw new Error(insertResult.error.message);
  }

  if (paused) return insertResult.data;
  if (input.dispatch === false) return insertResult.data;
  const scheduled = insertResult.data.scheduled_at
    ? new Date(insertResult.data.scheduled_at).getTime()
    : 0;
  if (scheduled > Date.now() + 5_000) return insertResult.data;
  return dispatchNotificationRecord(insertResult.data.id);
}

/**
 * يختار صف التسليم القائم من لقطة واحدة — الأحدث أولاً.
 *
 * The rows arrive from one query, so the answer must come from one read: the
 * newest `queued` or `sent` row is the delivery itself and wins over a newer
 * `failed` or `skipped` row (the contract-expiry job can leave those behind
 * under the same key), and when no such row exists the newest row of the
 * list is the one to reuse.
 *
 * A row without a readable `created_at` counts as the oldest, so an undated
 * list keeps the order it arrived in.
 */
export function pickExistingDelivery<T extends { created_at?: string | null; state: string }>(
  rows: readonly T[],
): T | undefined {
  const newestFirst = [...rows].sort((a, b) => createdAtMs(b) - createdAtMs(a));
  const delivery = newestFirst.find((row) => row.state === "queued" || row.state === "sent");
  return delivery ?? newestFirst[0];
}

/**
 * يحوّل تاريخ الصف إلى مللي ثانية — الصف بلا تاريخ صالح يُعدّ الأقدم.
 */
function createdAtMs(row: { created_at?: string | null }): number {
  if (!row.created_at) return 0;
  const parsed = Date.parse(row.created_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * يقرأ مفتاح إيقاف إشعارات المستأجر من سجله.
 *
 * Throws on a select error, like `companyEmail` below: a pause that could not
 * be read is not a pause that may be ignored, and reaching a tenant the owner
 * asked to silence is the one outcome this switch exists to prevent. A missing
 * row counts as not paused — there is no such tenant to notify.
 */
async function tenantNotificationsPaused(tenantId: string): Promise<boolean> {
  const tenant = await supabaseAdmin
    .from("tenants")
    .select("notifications_paused")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenant.error) throw new Error(tenant.error.message);
  return Boolean(tenant.data?.notifications_paused);
}

/**
 * Company inbox from the first companies row. Throws on a select error.
 */
async function companyEmail(): Promise<string | null> {
  const company = await supabaseAdmin
    .from("companies")
    .select("email")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (company.error) throw new Error(company.error.message);
  return company.data?.email ? String(company.data.email).toLowerCase() : null;
}

/**
 * Active admin profile emails. Swallows user_roles / profiles errors, unlike
 * companyEmail above, which throws.
 */
async function adminProfileEmails(): Promise<string[]> {
  const emails: string[] = [];
  const admins = await supabaseAdmin.from("user_roles").select("user_id").eq("role", "admin");
  if (!admins.error && admins.data?.length) {
    const profiles = await supabaseAdmin
      .from("profiles")
      .select("email")
      .in(
        "id",
        admins.data.map((row) => row.user_id),
      )
      .eq("is_active", true);
    if (!profiles.error) {
      for (const profile of profiles.data ?? []) {
        if (profile.email) emails.push(String(profile.email).toLowerCase());
      }
    }
  }
  return emails;
}

/**
 * Resolve address-level admin/company targets into a deduplicated email list.
 *
 * `tenant` is intentionally ignored here — it is block-level in each sender.
 * `"admin"` alone never queries `companies`. `"company"` alone never queries
 * profiles. Error asymmetry (company throws, admin swallows) is preserved.
 */
export async function resolveNotificationRecipients(
  targets: WorkflowRecipientTarget[],
): Promise<string[]> {
  const emails = new Set<string>();
  const wantCompany = targets.includes("company");
  const wantAdmin = targets.includes("admin");

  if (wantCompany) {
    const email = await companyEmail();
    if (email) emails.add(email);
  }
  if (wantAdmin) {
    for (const email of await adminProfileEmails()) {
      emails.add(email);
    }
  }

  return [...emails].filter((email) => email.includes("@"));
}
