import { runWithRequestCompany } from "@/company/requestCompany.server";
import { runEvolutionAvatarSweep } from "@/fns/evolutionAvatars.server";
import { runEvolutionHistorySweep } from "@/fns/evolutionHistorySync.server";
import type { JobPayload } from "@/jobs/catalog";
import type { JobHandler, JobHandlerContext } from "@/worker/runJob";

/**
 * يبني معالج مهمة `whatsapp.history.sync`: استيراد تاريخ محادثات الواتساب.
 *
 * The sweep is the moved work of `src/fns/evolutionHistorySync.server.ts` — bounded
 * and idempotent on message_id — so a retry of this job imports nothing twice.
 * The payload's `connectionId` scopes the connection read; another company's
 * id finds nothing (the connection is the per-company singleton of migration
 * 179 until `whatsapp_connections` lands in T160).
 */
export function createWhatsappHistorySyncHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { connectionId } = ctx.payload as JobPayload<"whatsapp.history.sync">;
    return runWithRequestCompany({ id: ctx.companyId, slug: "", status: "active", host: "" }, () =>
      runEvolutionHistorySweep({ companyId: ctx.companyId, connectionId }),
    );
  };
}

/** نتيجة مهمة `whatsapp.avatars.sync`: الأرقام التي فُحصت وحُدّثت. */
interface AvatarSyncResult {
  checked: number;
  updated: number;
  complete: boolean;
}

/**
 * يبني معالج مهمة `whatsapp.avatars.sync`: تحديث صور ملفات المحادثات.
 *
 * The dialog used to walk the directory across clicks with an `after` cursor;
 * the job walks it in one run instead, pass by pass, feeding each pass's
 * `nextCursor` into the next. The cursor that does not advance would spin the
 * loop forever, so the run reports `complete: false` and stops there instead.
 */
export function createWhatsappAvatarsSyncHandler(): JobHandler {
  return async (ctx: JobHandlerContext) => {
    const { connectionId } = ctx.payload as JobPayload<"whatsapp.avatars.sync">;
    return runWithRequestCompany(
      { id: ctx.companyId, slug: "", status: "active", host: "" },
      async (): Promise<AvatarSyncResult> => {
        let after: string | null = null;
        let checked = 0;
        let updated = 0;
        for (;;) {
          const pass = await runEvolutionAvatarSweep({
            companyId: ctx.companyId,
            connectionId,
            after,
          });
          checked += pass.checked;
          updated += pass.updated;
          if (pass.complete) return { checked, updated, complete: true };
          if (pass.nextCursor === after) return { checked, updated, complete: false };
          after = pass.nextCursor;
        }
      },
    );
  };
}
