import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createWorkflowFn,
  deleteWorkflowFn,
  type CreateWorkflowInput,
  type DeleteWorkflowInput,
} from "@/fns/manageWorkflow";
import { runWorkflowNow, type RunWorkflowNowInput } from "@/fns/runWorkflowNow";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";

export type CronJob = Tables<"cron_jobs">;

/**
 * The cron registry (migration 58).
 *
 * Before this there was no cron-run table at all — the only observability was
 * per-job `write_audit`, and not every job writes one, so "did the nightly job
 * actually run?" could not be answered from inside the app.
 */
export function useCronJobs(enabled = true) {
  return useQuery({
    queryKey: ["cron-jobs"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from("cron_jobs").select("*").order("key");
      if (error) throw error;
      return data ?? [];
    },
    // These rows change on every tick, so a long cache would show stale
    // "last run" times — the one thing this screen exists to report.
    staleTime: 15_000,
  });
}

/**
 * Pauses or resumes a job.
 *
 * Admin-only at the RLS level: pausing changes what the system does unattended.
 * A paused job is skipped by the cron endpoint with a `skipped` result rather
 * than an error — it is a deliberate state, not a failure.
 */
export function useSetCronJobActive() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      if (!permissions.can(PERMISSIONS.WORKFLOWS_MANAGE)) throw new Error("Permission denied.");
      const { data, error } = await supabase
        .from("cron_jobs")
        .update({ is_active: isActive })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: isActive ? "cron.resume" : "cron.pause",
        entityType: "cron_job",
        entityId: id,
        after: { key: data.key, is_active: data.is_active },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

/**
 * Updates who a workflow may notify. Direct table UPDATE under the existing
 * admin-UPDATE RLS policy — no server fn needed.
 *
 * Optimistic so the recipient pills feel instant; rolled back on error.
 */
export function useSetWorkflowRecipients() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      recipient_targets,
    }: {
      id: string;
      recipient_targets: WorkflowRecipientTarget[];
    }) => {
      if (!permissions.can(PERMISSIONS.WORKFLOWS_MANAGE)) throw new Error("Permission denied.");
      if (recipient_targets.length === 0) {
        throw new Error("At least one recipient target is required.");
      }
      const { data, error } = await supabase
        .from("cron_jobs")
        .update({ recipient_targets })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "cron.recipients",
        entityType: "cron_job",
        entityId: id,
        after: { key: data.key, recipient_targets: data.recipient_targets },
      });
      return data;
    },
    onMutate: async ({ id, recipient_targets }) => {
      await queryClient.cancelQueries({ queryKey: ["cron-jobs"] });
      const previous = queryClient.getQueryData<CronJob[]>(["cron-jobs"]);
      queryClient.setQueryData<CronJob[]>(["cron-jobs"], (old) =>
        old?.map((job) => (job.id === id ? { ...job, recipient_targets } : job)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["cron-jobs"], context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

async function sessionHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Registry-only create. The new row is not wired to any dispatcher until a
 * developer hardcodes it — see WORKFLOW_CATALOG and the JOBS map.
 */
export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: CreateWorkflowInput) => {
      if (!permissions.can(PERMISSIONS.WORKFLOWS_MANAGE)) throw new Error("Permission denied.");
      const headers = await sessionHeaders();
      return createWorkflowFn({ data: input, headers });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

/**
 * Deletes a non-built-in registry row. Built-in keys are refused server-side.
 */
export function useDeleteWorkflow() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: DeleteWorkflowInput) => {
      if (!permissions.can(PERMISSIONS.WORKFLOWS_MANAGE)) throw new Error("Permission denied.");
      const headers = await sessionHeaders();
      return deleteWorkflowFn({ data: input, headers });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

/**
 * Admin "run now" for a scheduled workflow. Invalidates on settle so a failed
 * run still refreshes last_status / last_error from the registry.
 */
export function useTestRunWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RunWorkflowNowInput) => {
      const headers = await sessionHeaders();
      return runWorkflowNow({ data: input, headers });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}
