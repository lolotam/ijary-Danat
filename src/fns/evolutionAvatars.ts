import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { openConnection } from "@/fns/evolutionAvatars.server";
import { NO_OPEN_SESSION_MESSAGE } from "@/fns/evolutionSession.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedSyncJob } from "@/jobs/handlers/sync";
import { requirePermission } from "@/fns/requirePermission";
import { companyMoment } from "@/worker/scheduler";

// The sweep and the per-message backfill live in `@/fns/evolutionAvatars.server`:
// this module is imported by the browser (the inbox's sync button), so it holds
// only the server function, whose handler body the compiler strips from the client.
export type { EvolutionAvatarSyncResult } from "@/fns/evolutionAvatars.server";

/**
 * يحجز مهمة مزامنة صور الملفات الشخصية خارج الطلب: يتحقق من الصلاحية ومن
 * الجلسة، ثم يسجّل مهمة `whatsapp.avatars.sync` ويعيد معرّفها.
 *
 * The cursor the dialog used to pass between clicks is gone with the request:
 * the worker job walks the whole directory itself, pass by pass, and files one
 * job per connection per day (contracts/jobs.md section 5: dedupe connection
 * id + day). The click keeps its fail-fast session read so a closed session is
 * refused on screen.
 */
export const syncEvolutionAvatars = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<QueuedSyncJob> => {
    await requirePermission(context, {
      code: "settings.integrations",
      attempted: "whatsapp.sync_avatars",
      refusal: "You do not have permission to sync WhatsApp avatars.",
    });

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);
    const connection = await openConnection(db, companyId);
    if (!connection) {
      throw new Error(NO_OPEN_SESSION_MESSAGE);
    }

    const day = companyMoment(new Date()).date;
    const { jobId } = await enqueueJob(
      db,
      "whatsapp.avatars.sync",
      { connectionId: connection.id },
      { dedupeKey: `whatsapp.avatars.sync:${connection.id}:${day}` },
    );

    return { queued: true, jobRequestId: jobId };
  });
