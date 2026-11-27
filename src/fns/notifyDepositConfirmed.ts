import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { loadCompanyDefaults, rowOrThrow } from "@/fns/adminEmailNotification";
import { enqueueNotification, resolveNotificationRecipients } from "@/fns/enqueueNotification";
import { loadTemplateCopy } from "@/fns/loadTemplateCopy";
import { runEventWorkflow } from "@/fns/workflowRegistry";
import { depositConfirmationTemplate, renderEmailDocument } from "@/lib/emailTemplates";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

async function enqueueDepositConfirmation(depositId: string, targets: WorkflowRecipientTarget[]) {
  const db = companyClient(requireRequestCompany().id);
  const deposit = rowOrThrow(await db.from("deposits").select("*").eq("id", depositId).single());
  if (deposit.status !== "confirmed") {
    return { skipped: true as const, reason: "Deposit is not confirmed." };
  }

  // Idempotency: skip if we already logged a deposit confirmation for this deposit.
  const existing = await db
    .from("notifications")
    .select("id")
    .eq("type", "deposit_confirmation")
    .contains("payload", { deposit_id: depositId })
    .neq("state", "cancelled")
    .limit(1);
  // A failed check is not "not yet notified" — throw, or a transient fault
  // sends the admin a duplicate. Kept inline because the caller needs the ids.
  if (existing.error) {
    throw new Error(
      `Could not check for an earlier deposit_confirmation notification: ${existing.error.message}`,
    );
  }
  if (existing.data?.length) {
    return {
      skipped: true as const,
      reason: "Already notified.",
      benign: true as const,
      ids: existing.data.map((r) => r.id),
    };
  }

  // Address-level filter only — no targets.includes("admin") around this block.
  const adminEmails = await resolveNotificationRecipients(targets);
  if (!adminEmails.length) {
    return { skipped: true as const, reason: "No admin email recipients configured." };
  }

  const { locale } = await loadCompanyDefaults();
  const amount = `${deposit.amount} ${deposit.currency}`;
  const variables = {
    amount,
    bank_name: deposit.bank_name,
    deposit_date: deposit.deposit_date,
    code: deposit.code,
    note: deposit.note ?? "",
  };
  const code = "deposit-confirmation";
  const copy = await loadTemplateCopy(code, locale, variables);
  const builtIn = depositConfirmationTemplate({
    locale,
    amount,
    bankName: deposit.bank_name,
    depositDate: deposit.deposit_date,
    code: deposit.code,
    note: deposit.note,
  });
  // The stored template wins; the builder is the safety net for a deleted or
  // inactive row, never a second source of truth for the happy path.
  const subject = copy.subject ?? builtIn.subject;
  const body = copy.body ? renderEmailDocument(locale, subject, copy.body) : builtIn.html;

  const payload = {
    deposit_id: depositId,
    recipients: adminEmails,
    attachment_paths: deposit.attachment_path ? [deposit.attachment_path] : [],
    attachment_bucket: "deposit-attachments",
    bank_name: deposit.bank_name,
    amount,
  };

  const notification = await enqueueNotification({
    type: "deposit_confirmation",
    channel: "email",
    audience: "admin",
    locale,
    subject,
    body,
    recipientAddress: adminEmails[0],
    templateCode: code,
    payload,
  });
  // A template set to WhatsApp only makes enqueueNotification drop the row and
  // return null. Returning that as a send recorded the run as `success` while
  // nothing was queued; the other admin senders already report it as a skip.
  if (!notification) {
    return { skipped: true as const, reason: `Template ${code} excludes the email channel.` };
  }

  return { skipped: false as const, notification };
}

/**
 * المُرسِل الذي يراه المشرفون باسم "تأكيد الإيداع".
 *
 * The pause check lives here rather than at the call site — the
 * `deposit.confirmed` job handler — so it cannot be forgotten.
 */
export async function notifyDepositConfirmedRecord(depositId: string) {
  type Result = Awaited<ReturnType<typeof enqueueDepositConfirmation>>;
  return runEventWorkflow<Result>({
    key: "deposit-confirmed",
    whenPaused: () => ({
      skipped: true as const,
      reason: "Workflow is paused.",
      benign: true as const,
      ids: [] as string[],
    }),
    run: (targets) => enqueueDepositConfirmation(depositId, targets),
    // Three of this sender's outcomes are skips, not sends: the deposit is not
    // confirmed, it was already notified, or no admin recipients are
    // configured. Recording them as successes would hide the third, which is a
    // real misconfiguration an admin needs to see. The reason is carried into
    // last_error so the row says *why* it skipped.
    outcomeOf: (result) =>
      result.skipped
        ? { status: "skipped" as const, error: result.reason }
        : { status: "success" as const, error: null },
  });
}
