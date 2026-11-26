import type { PostgrestSingleResponse } from "@supabase/supabase-js";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { alreadyNotified } from "@/fns/notificationSkip";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import type { Json, NotificationType, Tables } from "@/integrations/supabase/database.types";
import { renderEmailDocument, type EmailLocale } from "@/lib/emailTemplates";
import { escapeVariables } from "@/lib/templateRender";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

/**
 * المسار المشترك لتنبيهات الإدارة البريدية التي تطلقها الأحداث.
 *
 * Eight senders (write-off, dispute, close-out, restore, refund, maintenance,
 * contact inquiry, contract created/ended) each carried a private copy of the
 * same pipeline: load the row, skip if already notified, resolve admin
 * addresses, render the stored template over a built-in fallback, enqueue,
 * and report a channel-gated null as a skip. That null check was pasted into
 * each copy by hand, and the one sender written without it (deposit
 * confirmation) recorded a dropped row as a successful send. What stays in
 * each sender is only what actually differs: which row it loads, which
 * variables it exposes, and its fallback copy. `notifyAdminEvent` is the one
 * entry point they call; the row loader and the tenant-name / contract-code
 * lookups several of them share live here too.
 *
 * `notifyDepositConfirmed` does not use `notifyAdminEvent`: it has a status
 * pre-check, returns the ids of earlier rows, and renders through a built-in
 * template builder. Folding those into this helper would add a branch per
 * special case, which is the wrong abstraction.
 */

/** نتيجة مُرسِل تنبيه إداري: إمّا صف الإشعار المُدرج، أو سبب التخطّي. */
export type AdminNotificationResult =
  | { skipped: true; reason: string; benign?: true }
  | { skipped: false; notification: Tables<"notifications"> };

/** نسخة الرسالة الجاهزة للإدراج في الطابور. */
export interface AdminEmailCopy {
  body: string;
  code: string;
  locale: EmailLocale;
  subject: string;
}

/** لغة الشركة الافتراضية وعملتها، كما تُقرأ لكل رسالة إدارية. */
export interface CompanyDefaults {
  currency: string;
  locale: EmailLocale;
}

/**
 * يقرأ لغة الشركة الافتراضية وعملتها لشركة الطلب أو المعرّف الممرّر، مع قيم احتياطية عند غياب الصف.
 */
export async function loadCompanyDefaults(companyId?: string): Promise<CompanyDefaults> {
  const resolvedCompanyId = companyId ?? requireRequestCompany().id;
  const company = await companyClient(resolvedCompanyId)
    .from("companies")
    .select("default_locale, currency")
    .eq("id", resolvedCompanyId)
    .maybeSingle();
  return {
    locale: (company.data?.default_locale ?? "ar") as EmailLocale,
    currency: company.data?.currency ?? "KWD",
  };
}

/**
 * يعيد الصف من نتيجة `.single()`، ويرمي برسالة قاعدة البيانات إن فشل.
 *
 * Every sender loads its entity this way, and a missing row must throw rather
 * than skip: a notification for an id that does not exist is a caller bug.
 */
export function rowOrThrow<T>(result: PostgrestSingleResponse<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** يقرأ اسم المستأجر للرسالة ضمن نطاق الشركة، أو "-" حين لا يوجد صف. */
export async function loadTenantName(tenantId: string): Promise<string> {
  const tenant = await companyClient(requireRequestCompany().id)
    .from("tenants")
    .select("name")
    .eq("id", tenantId)
    .maybeSingle();
  return tenant.data?.name ?? "-";
}

/** يقرأ رمز العقد للرسالة ضمن نطاق الشركة، أو "-" حين لا يوجد صف. */
export async function loadContractCode(contractId: string): Promise<string> {
  const contract = await companyClient(requireRequestCompany().id)
    .from("contracts")
    .select("code")
    .eq("id", contractId)
    .maybeSingle();
  return contract.data?.code ?? "-";
}

export interface AdminEmailCopyInput {
  code: string;
  locale: EmailLocale;
  variables: Record<string, string>;
  fallbackSubject: string;
  /** يبني نص الرسالة الاحتياطي من المتغيرات بعد تهريبها. */
  fallbackBody: (safe: Record<string, string>) => string;
}

/**
 * يبني عنوان الرسالة ونصها: القالب المخزّن أولاً، والنص المدمج احتياطاً.
 *
 * The fallback only receives escaped variables, because tenant names and
 * free-text reasons reach this HTML verbatim otherwise.
 */
export async function renderAdminEmailCopy(input: AdminEmailCopyInput): Promise<AdminEmailCopy> {
  const copy = await loadTemplateCopy(input.code, input.locale, input.variables);
  const subject = copy.subject ?? input.fallbackSubject;
  const body = copy.body ?? input.fallbackBody(escapeVariables(input.variables));
  return {
    body: renderEmailDocument(input.locale, subject, body),
    code: input.code,
    locale: input.locale,
    subject,
  };
}

/** ما يبنيه المُرسِل من الصف المحمَّل: نسخة الرسالة وحمولتها. */
export interface AdminEmailMessage {
  copy: AdminEmailCopy;
  /** حمولة الإشعار دون `recipients`، التي يضيفها المسار المشترك. */
  payload: Record<string, Json>;
  contractId?: string;
}

export interface AdminEmailSpec<TEntity> {
  type: NotificationType;
  load: () => Promise<TEntity>;
  /** مطابقة الحمولة التي تعني أن هذا الحدث أُبلغ عنه من قبل. */
  dedupeMatch: Record<string, Json>;
  build: (entity: TEntity) => Promise<AdminEmailMessage>;
  /**
   * سبب التخطّي حين يفشل الإدراج، لمن لا يجوز أن يرفض فشلُ البريد عمليتَه.
   *
   * Set by the senders that fire after money has already moved (write-off,
   * dispute, close-out, restore): a mail failure there must never reject the
   * committed write. Left unset, the error propagates, as the other senders
   * have always done.
   */
  sendFailureReason?: string;
}

/**
 * يحمّل الصف ويتحقق من عدم تكرار التنبيه ويدرج رسالة بريدية للإدارة.
 *
 * The row is loaded before the dedupe check so that a missing entity still
 * throws: a notification for an id that does not exist is a caller bug, not a
 * skip.
 */
export async function enqueueAdminEmail<TEntity>(
  spec: AdminEmailSpec<TEntity>,
  targets: WorkflowRecipientTarget[],
): Promise<AdminNotificationResult> {
  const entity = await spec.load();
  if (await alreadyNotified(spec.type, spec.dedupeMatch)) {
    return { skipped: true, reason: "Already notified.", benign: true };
  }

  // Address-level filter only — no targets.includes("admin") around this block.
  const adminEmails = await resolveNotificationRecipients(targets);
  if (!adminEmails.length) {
    return { skipped: true, reason: "No admin email recipients configured." };
  }

  const message = await spec.build(entity);
  try {
    return await insertAdminEmail(spec.type, message, adminEmails);
  } catch (error) {
    if (spec.sendFailureReason === undefined) throw error;
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : spec.sendFailureReason,
    };
  }
}

/** يدرج صف الإشعار ويحوّل إسقاط البوابة للقناة إلى تخطٍّ مُعلَن. */
async function insertAdminEmail(
  type: NotificationType,
  message: AdminEmailMessage,
  adminEmails: string[],
): Promise<AdminNotificationResult> {
  const { copy } = message;
  const notification = await enqueueNotification({
    type,
    channel: "email",
    audience: "admin",
    locale: copy.locale,
    subject: copy.subject,
    body: copy.body,
    recipientAddress: adminEmails[0],
    templateCode: copy.code,
    contractId: message.contractId,
    payload: { ...message.payload, recipients: adminEmails },
  });
  // هذه التنبيهات الإدارية بريدية فقط، فقالب مضبوط على واتساب يعني ألا يُرسل شيء.
  // The gate in enqueueNotification dropped the row rather than queue a delivery
  // on a channel the admin switched off; report that instead of crashing on null.
  if (!notification) {
    return { skipped: true, reason: `Template ${copy.code} excludes the email channel.` };
  }
  return { skipped: false, notification };
}

/**
 * يشغّل مُرسِلاً إدارياً داخل بوابة سير العمل: الإيقاف والتسجيل في `cron_jobs`.
 *
 * A skip is recorded as `skipped` with its reason, never as `success`: "no
 * admin recipients configured" is a misconfiguration an admin needs to see.
 */
function runAdminEmailWorkflow(
  key: string,
  run: (targets: WorkflowRecipientTarget[]) => Promise<AdminNotificationResult>,
): Promise<AdminNotificationResult> {
  return runEventWorkflow<AdminNotificationResult>({
    key,
    whenPaused: () => ({ skipped: true, reason: "Workflow is paused.", benign: true }),
    run,
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped", error: result.reason }
        : { status: "success", error: null },
  });
}

/**
 * يرسل تنبيهاً إدارياً بريدياً لحدث واحد: بوابة سير العمل حول المسار المشترك.
 *
 * Every sender composed `runAdminEmailWorkflow` around `enqueueAdminEmail` in
 * exactly the same way; this is that composition, so a sender states only its
 * workflow key and its spec.
 */
export function notifyAdminEvent<TEntity>(
  workflowKey: string,
  spec: AdminEmailSpec<TEntity>,
): Promise<AdminNotificationResult> {
  return runAdminEmailWorkflow(workflowKey, (targets) => enqueueAdminEmail(spec, targets));
}
