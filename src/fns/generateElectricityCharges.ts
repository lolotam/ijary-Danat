import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/fns/requirePermission";

const generateElectricityChargesSchema = z.object({
  periodMonth: z.number().int().min(1).max(12),
  periodYear: z.number().int().min(2000).max(2200),
  unitId: z.string().uuid().nullable().optional(),
});

export type GenerateElectricityChargesInput = z.infer<typeof generateElectricityChargesSchema>;

export const generateElectricityCharges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(generateElectricityChargesSchema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "electricity.create",
      attempted: "electricity.generate_charges",
      refusal: "You do not have permission to generate electricity charges.",
    });

    const generatedCharges = await context.supabase.rpc("generate_electricity_charges", {
      p_period_month: data.periodMonth,
      p_period_year: data.periodYear,
      p_unit_id: data.unitId ?? null,
    });
    if (generatedCharges.error) throw new Error(generatedCharges.error.message);
    return generatedCharges.data;
  });
