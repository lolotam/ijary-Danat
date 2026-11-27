import { companyClient } from "@/company/companyClient.server";
import type { JobHandler } from "@/worker/runJob";

/** نتيجة مهمة `usage.rebuild`: حجم تخزين الشركة بعد إعادة الحساب، بالبايت. */
export interface UsageRebuildResult {
  storageBytes: number;
}

/**
 * يبني معالج مهمة `usage.rebuild`: إعادة حساب استهلاك التخزين من الصفر.
 *
 * The storage counters are normally kept in step by the trigger on
 * `storage.objects`, but a trigger that missed a row leaves the total wrong
 * and nothing else would notice. The rebuild sums the stored objects again
 * and writes the total back, so it derives the usage from the objects
 * themselves rather than from the counter it repairs — a retry therefore
 * reaches the same state, and running it twice is not a double count.
 *
 * The WhatsApp monthly counter is deliberately left alone: it is the send
 * ledger itself, not a total derived from other rows, so recomputing it
 * would invent sends that never happened.
 *
 * The call runs as `company_service`, and the RPC reads the company from the
 * claim the client signs, so a rebuild only ever touches its own company's
 * files. The payload's `date` is ignored on purpose: the function sums what
 * is stored now, so a reference day would claim a past total the function
 * does not answer.
 */
export function createUsageRebuildHandler(): JobHandler {
  return async (ctx): Promise<UsageRebuildResult> => {
    const db = companyClient(ctx.companyId);
    const { data, error } = await db.rpc("rebuild_company_storage_usage");
    if (error) throw new Error(`storage usage rebuild failed: ${error.message}`);
    if (data === null) throw new Error("storage usage rebuild returned no total");
    return { storageBytes: data };
  };
}
