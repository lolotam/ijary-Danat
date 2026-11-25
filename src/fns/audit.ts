import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuditResult, Json } from "@/integrations/supabase/database.types";

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

const auditInputSchema = z.object({
  action: z.string().trim().min(1),
  entityType: z.string().trim().min(1).nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  before: jsonSchema.nullable().optional(),
  after: jsonSchema.nullable().optional(),
  result: z.enum(["success", "failure", "error"]).optional(),
  errorCode: z.string().trim().min(1).nullable().optional(),
});

export type AuditInput = z.infer<typeof auditInputSchema>;

export const logAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(auditInputSchema)
  .handler(async ({ data, context }) => {
    const { data: auditId, error } = await context.supabase.rpc("write_audit", {
      p_action: data.action,
      p_entity_type: data.entityType ?? null,
      p_entity_id: data.entityId ?? null,
      p_before: data.before ?? null,
      p_after: data.after ?? null,
      p_result: (data.result ?? "success") satisfies AuditResult,
      p_error_code: data.errorCode ?? null,
    });

    if (error) {
      throw new Error(`Audit log write failed: ${error.message}`);
    }

    return { id: auditId };
  });
