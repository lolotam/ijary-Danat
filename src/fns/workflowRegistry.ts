import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

/**
 * The `cron_jobs` registry serves two kinds of automation: the jobs the cron
 * endpoint dispatches on a schedule, and the workflows an application event
 * fires. Both need the same two operations, so they share one implementation
 * here rather than two that drift.
 *
 * The table keeps its `cron_jobs` name for the reasons in migration 69.
 */

export type WorkflowRunStatus = "success" | "error" | "skipped";

const FAIL_OPEN_TARGETS: WorkflowRecipientTarget[] = ["admin", "company", "tenant"];

/**
 * One registry read: pause switch + recipient targets.
 *
 * Fails OPEN: if the registry cannot be read, the caller proceeds with every
 * target enabled. A registry outage must not silently stop invoices being
 * marked overdue or a tenant receiving their receipt — observability must
 * never become a single point of failure for the thing it observes.
 *
 * An unregistered key is likewise not paused and gets all targets, so a sender
 * whose row was never seeded keeps working.
 */
export async function readWorkflowGate(key: string): Promise<{
  paused: boolean;
  targets: WorkflowRecipientTarget[];
}> {
  try {
    const { data, error } = await companyClient(requireRequestCompany().id)
      .from("cron_jobs")
      .select("is_active, recipient_targets")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) {
      return { paused: false, targets: FAIL_OPEN_TARGETS };
    }
    const raw = data.recipient_targets;
    const targets =
      Array.isArray(raw) && raw.length > 0 ? (raw as WorkflowRecipientTarget[]) : FAIL_OPEN_TARGETS;
    return {
      paused: data.is_active === false,
      targets,
    };
  } catch {
    return { paused: false, targets: FAIL_OPEN_TARGETS };
  }
}

/**
 * Whether an admin has paused this workflow.
 *
 * Thin wrapper over {@link readWorkflowGate}. Kept so `cronJobs.ts` and any
 * other pause-only call sites stay unchanged.
 */
export async function isWorkflowPaused(key: string): Promise<boolean> {
  const { paused } = await readWorkflowGate(key);
  return paused;
}

/**
 * Records the outcome in the registry.
 *
 * Deliberately swallows its own failures: recording that a workflow ran must
 * never be able to make the workflow report failure. Same principle as above,
 * in the other direction.
 */
export async function recordWorkflowRun(
  key: string,
  status: WorkflowRunStatus,
  durationMs: number,
  errorMessage: string | null,
): Promise<void> {
  try {
    await companyClient(requireRequestCompany().id).rpc("record_cron_run", {
      _key: key,
      _status: status,
      _duration_ms: durationMs,
      _error: errorMessage,
    });
  } catch {
    // Intentionally ignored.
  }
}

/**
 * Runs an event-triggered workflow under the registry: honours the pause
 * switch, times the run, and records the outcome.
 *
 * This exists so the gate is applied identically by every sender. The
 * alternative — a pause check at each of the five call sites — is exactly where
 * one gets missed, and a missed one is invisible: the switch still looks right
 * in the UI. Recipient targets ride the same gate for the same reason.
 *
 * `whenPaused` returns the caller's own skip shape, so each sender keeps its
 * existing return contract instead of every caller learning a new one.
 *
 * `run` receives the resolved recipient targets so senders can filter without
 * a second registry lookup.
 *
 * `outcomeOf` exists for senders that return their outcome rather than throwing.
 * A result means one of three things — it broke, it had nothing to do, or it
 * sent — and a sender that returns `{ ok: false }` for a declined card is
 * reporting the second, not the first. Without this hook every such result
 * would be recorded as a success (hiding real misconfiguration) or as an error
 * (painting the monitoring tab permanently red). Senders that simply throw need
 * no classifier.
 *
 * Duration measures building and enqueueing the notification, not delivering
 * it: delivery happens later, in the notification-drain job.
 */
export async function runEventWorkflow<T>(options: {
  key: string;
  whenPaused: () => T;
  run: (targets: WorkflowRecipientTarget[]) => Promise<T>;
  outcomeOf?: (result: T) => { status: WorkflowRunStatus; error: string | null };
}): Promise<T> {
  const { key, whenPaused, run, outcomeOf } = options;

  const { paused, targets } = await readWorkflowGate(key);
  if (paused) {
    await recordWorkflowRun(key, "skipped", 0, null);
    return whenPaused();
  }

  const startedAt = Date.now();
  try {
    const result = await run(targets);
    const outcome = outcomeOf?.(result) ?? { status: "success" as const, error: null };
    await recordWorkflowRun(key, outcome.status, Date.now() - startedAt, outcome.error);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${key} failed.`;
    await recordWorkflowRun(key, "error", Date.now() - startedAt, message);
    throw error;
  }
}
