import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { assertNotSupportSession } from "@/company/supportSessionGuard";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseServerInput } from "@/lib/parseServerInput";
import { updateAuthUserById } from "@/platform/authAdmin.server";

const changeOwnPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});

/**
 * يغيّر كلمة مرور المستخدم المسجّل نفسه عبر مسار GoTrue الإداري، ويرفض ذلك أثناء جلسة الدعم الفني.
 *
 * T201 F1: the portal used to call `supabase.auth.updateUser` from the browser,
 * which is GoTrue's `PUT /auth/v1/user`. GoTrue accepts any JWT signed with the
 * project secret there, so a support-session token could change the renter's
 * password and keep access after the session ended. The change now runs here,
 * where `assertNotSupportSession` sees the token's `impersonator` claim, and
 * the gateway refuses direct `PUT /auth/v1/user` (see `deploy/ijary/README.md`).
 */
export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseServerInput(changeOwnPasswordSchema, data))
  .handler(async ({ data, context }) => {
    assertNotSupportSession((context as { claims?: unknown } | undefined)?.claims);
    const { userId } = context as { userId: string };
    const { error } = await updateAuthUserById(userId, { password: data.password });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
