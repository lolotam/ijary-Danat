import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/database.types";
import { isBuiltInWorkflow } from "@/lib/workflowCatalog";
import type { WorkflowRecipientTarget } from "@/lib/workflowCatalog";
import { requirePermission } from "@/fns/requirePermission";

/**
 * Create / delete registry rows in `cron_jobs`.
 *
 * There is deliberately no INSERT or DELETE RLS policy for `authenticated` —
 * both operations go through supabaseAdmin so the built-in-key guard lives in
 * one place and cannot be bypassed by a direct PostgREST call.
 *
 * Every failure path throws an `Error`, never a `Response`. A thrown Response
 * resolves client-side as success through the x-tss-raw path.
 */

const KEY_RE = /^[a-z0-9-]+$/;

const recipientTargetSchema = z.enum(["admin", "company", "tenant"]);

const createSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(KEY_RE, "Key must be lowercase letters, digits, and hyphens only."),
  kind: z.enum(["scheduled", "event"]),
  name_ar: z.string().trim().min(1).max(200),
  name_en: z.string().trim().min(1).max(200),
  description_ar: z.string().trim().max(1000).nullable().optional(),
  description_en: z.string().trim().max(1000).nullable().optional(),
  recipient_targets: z.array(recipientTargetSchema).min(1).optional(),
});

const deleteSchema = z.object({
  key: z.string().trim().min(1).max(64),
});

export type CreateWorkflowInput = z.infer<typeof createSchema>;
export type DeleteWorkflowInput = z.infer<typeof deleteSchema>;

/**
 * يقصر إنشاء سير العمل وحذفه على من يملك صلاحية إدارة سير العمل.
 *
 * Both handlers write through supabaseAdmin, which bypasses RLS entirely, so
 * this is the only gate. It checks the same code as the cron_jobs UPDATE policy
 * (migration 230): pausing a workflow and deleting one must not need different
 * grants.
 */
async function requireWorkflowManager(context: {
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<void> {
  await requirePermission(context, {
    code: "workflows.manage",
    attempted: "workflow.manage",
    refusal: "You do not have permission to manage workflows.",
  });
}

export const createWorkflowFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(createSchema)
  .handler(async ({ data, context }) => {
    await requireWorkflowManager(context);

    if (isBuiltInWorkflow(data.key)) {
      throw new Error(
        `Key "${data.key}" is a built-in workflow and cannot be created from the UI.`,
      );
    }

    const existing = await supabaseAdmin
      .from("cron_jobs")
      .select("id")
      .eq("key", data.key)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      throw new Error(`A workflow with key "${data.key}" already exists.`);
    }

    const targets: WorkflowRecipientTarget[] = data.recipient_targets ?? ["admin", "company"];

    const inserted = await supabaseAdmin
      .from("cron_jobs")
      .insert({
        key: data.key,
        kind: data.kind,
        name_ar: data.name_ar,
        name_en: data.name_en,
        description_ar: data.description_ar ?? null,
        description_en: data.description_en ?? null,
        recipient_targets: targets,
        is_active: true,
      })
      .select("*")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);

    await supabaseAdmin.rpc("write_audit", {
      p_action: "cron.create",
      p_entity_type: "cron_job",
      p_entity_id: inserted.data.id,
      p_before: null,
      p_after: {
        key: inserted.data.key,
        kind: inserted.data.kind,
        recipient_targets: inserted.data.recipient_targets,
      },
      p_result: "success",
      p_error_code: null,
    });

    return { created: true as const, workflow: inserted.data };
  });

export const deleteWorkflowFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(deleteSchema)
  .handler(async ({ data, context }) => {
    await requireWorkflowManager(context);

    if (isBuiltInWorkflow(data.key)) {
      throw new Error(`Key "${data.key}" is a built-in workflow and cannot be deleted.`);
    }

    const existing = await supabaseAdmin
      .from("cron_jobs")
      .select("*")
      .eq("key", data.key)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) {
      throw new Error(`No workflow found with key "${data.key}".`);
    }

    const deleted = await supabaseAdmin.from("cron_jobs").delete().eq("key", data.key);
    if (deleted.error) throw new Error(deleted.error.message);

    await supabaseAdmin.rpc("write_audit", {
      p_action: "cron.delete",
      p_entity_type: "cron_job",
      p_entity_id: existing.data.id,
      p_before: {
        key: existing.data.key,
        kind: existing.data.kind,
        name_en: existing.data.name_en,
      },
      p_after: null,
      p_result: "success",
      p_error_code: null,
    });

    return { deleted: true as const, key: data.key };
  });
