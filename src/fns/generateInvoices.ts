import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const schema = z.object({
  contractId: z.string().uuid().nullable().optional(),
  throughYear: z.number().int().min(2000).max(2200).nullable().optional(),
});

export type GenerateInvoicesInput = z.infer<typeof schema>;

export const generateInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "invoices.create",
      attempted: "invoice.generate",
      refusal: "You do not have permission to generate invoices.",
    });
    const { data: rows, error } = await context.supabase.rpc("generate_invoices", {
      p_contract_id: data.contractId ?? null,
      p_through_year: data.throughYear ?? null,
    });
    if (error) throw new Error(error.message);
    return rows;
  });
