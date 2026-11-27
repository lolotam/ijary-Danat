import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { loadQrConnection, NO_OPEN_SESSION_MESSAGE } from "@/fns/evolutionSession.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { enqueueJob } from "@/jobs/enqueue";
import type { QueuedSyncJob } from "@/jobs/handlers/sync";
import { requirePermission, type PermissionContext } from "@/fns/requirePermission";
import { companyMoment } from "@/worker/scheduler";

// The sweep itself lives in `@/fns/evolutionHistorySync.server`: this module is
// imported by the browser (the inbox's sync button), so it holds only the
// server function, whose handler body the compiler strips from the client.
export type { EvolutionHistorySyncResult } from "@/fns/evolutionHistorySync.server";

/** يقصر مزامنة سجل واتساب على من يملك صلاحية إدارة التكاملات، ويسجّل الرفض. */
async function assertCanManageIntegrations(context: PermissionContext) {
  await requirePermission(context, {
    code: "settings.integrations",
    attempted: "whatsapp.sync_history",
    refusal: "You do not have permission to sync WhatsApp history.",
  });
}

/**
 * يحجز مهمة مزامنة تاريخ المحادثات خارج الطلب: يتحقق من الصلاحية ومن الجلسة،
 * ثم يسجّل مهمة `whatsapp.history.sync` ويعيد معرّفها.
 *
 * The sweep runs in the worker now (contracts/jobs.md section 1). The click
 * keeps its fail-fast reads — a closed session is refused on screen instead of
 * failing a minute later in a job nobody watches — and then queues one job per
 * connection per day (contracts/jobs.md section 5: dedupe connection id + day).
 * The job is idempotent on its own: the ingest RPC dedupes on message_id, so a
 * retry imports nothing twice.
 */
export const runEvolutionHistorySync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<QueuedSyncJob> => {
    await assertCanManageIntegrations(context as never);

    const companyId = requireRequestCompany().id;
    const db = companyClient(companyId);

    const connection = await loadQrConnection(db, companyId);
    if (!connection || connection.status !== "connected") {
      throw new Error(NO_OPEN_SESSION_MESSAGE);
    }

    const day = companyMoment(new Date()).date;
    const { jobId } = await enqueueJob(
      db,
      "whatsapp.history.sync",
      { connectionId: connection.id },
      { dedupeKey: `whatsapp.history.sync:${connection.id}:${day}` },
    );

    return { queued: true, jobRequestId: jobId };
  });
