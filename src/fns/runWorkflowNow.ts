import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { JOB_ALREADY_RUNNING, JOBS, withJobLock } from "@/fns/cronJobs";
import { isWorkflowPaused, recordWorkflowRun } from "@/fns/workflowRegistry";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import { requirePermission } from "@/fns/requirePermission";

/**
 * Admin-triggered "run now" for a scheduled workflow.
 *
 * Mirrors the pause / lock / time / record sequence in respondToCronRequest
 * (cronJobs.ts) — including its double-fire lock — but stays user-scoped: the
 * caller must hold the catalog's runPermission. Only `/api/public/cron` runs
 * as service_role.
 *
 * Event keys are rejected — an event workflow has no payload to replay.
 *
 * Authorization failures throw `Error`, never `Response` (a thrown Response
 * resolves as success on the client via x-tss-raw).
 */

type ScheduledJobName = keyof typeof JOBS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z.object({
  key: z.string().trim().min(1),
  asOf: z.string().regex(ISO_DATE, "asOf must be a YYYY-MM-DD date.").nullable().optional(),
});

export type RunWorkflowNowInput = z.infer<typeof schema>;

export const runWorkflowNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    // Dispatches from the cron endpoint's own map rather than a second copy, so a
    // job can never be runnable from one path and missing from the other. The
    // check stays inline: a top-level helper reading `JOBS` would keep
    // `cronJobs` (and every server-only job) in the browser bundle.
    if (!Object.prototype.hasOwnProperty.call(JOBS, data.key)) {
      throw new Error(
        `Only scheduled workflows can be run now. "${data.key}" is not a dispatchable scheduled job.`,
      );
    }

    const catalog = WORKFLOW_CATALOG[data.key];
    const runPermission = catalog?.runPermission;
    if (!runPermission) {
      throw new Error(`No run permission configured for workflow "${data.key}".`);
    }

    await requirePermission(context, {
      code: runPermission,
      attempted: "workflow.run_now",
      refusal: "Permission denied.",
    });

    // A paused job is a deliberate state, not a failure — return a skipped
    // result rather than an error, matching respondToCronRequest.
    if (await isWorkflowPaused(data.key)) {
      await recordWorkflowRun(data.key, "skipped", 0, null);
      return { job: data.key, durationMs: 0, skipped: true as const };
    }

    // The lock is taken only after the checks above, so a refused or paused
    // call never acquires it. `key` is hoisted and cast once, after the
    // membership check above, so the closure below can index `JOBS`.
    const key = data.key as ScheduledJobName;
    const asOf = data.asOf ?? null;
    const outcome = await withJobLock(key, async () => {
      const startedAt = Date.now();
      try {
        const result = await JOBS[key](asOf);
        const durationMs = Date.now() - startedAt;
        await recordWorkflowRun(key, "success", durationMs, null);
        return { job: key, durationMs, result, skipped: false as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Job failed.";
        const durationMs = Date.now() - startedAt;
        await recordWorkflowRun(key, "error", durationMs, message);
        throw new Error(message, { cause: error });
      }
    });

    if (outcome === JOB_ALREADY_RUNNING) {
      // Thrown as Error, never Response: a thrown Response resolves as
      // success on the client via x-tss-raw (see the note at the top of this
      // file). Nothing is recorded — the in-flight run records itself.
      throw new Error(`Job "${key}" is already running.`);
    }
    return outcome;
  });
