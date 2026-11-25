import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireRole } from "@/fns/requirePermission";

/**
 * يمسح بيانات التشغيل كلها بعد التحقق من أن المستدعي مدير.
 *
 * The RPC checks `has_role(auth.uid(), 'admin')` itself; the check here is
 * defence in depth, and it turns a refusal into a readable message instead of
 * a raw Postgres exception.
 */
export const eraseAllData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireRole(context, "admin", {
      attempted: "data.erase_all",
      refusal: "Only an admin may reset the database.",
    });

    const { error } = await context.supabase.rpc("erase_all_data");
    if (error) {
      console.error("Error executing database erase:", error);
      throw new Error(error.message);
    }

    return { success: true };
  });
