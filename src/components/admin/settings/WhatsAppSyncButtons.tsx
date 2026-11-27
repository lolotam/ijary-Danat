import { History, ImageDown } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  useRunEvolutionHistorySync,
  useSyncEvolutionAvatars,
} from "@/hooks/useEvolutionConnection";
import { useI18n } from "@/i18n/provider";
import { describeError } from "@/lib/toastError";

/**
 * يعرض زرّي مزامنة سجل المحادثات وصور الملفات الشخصية لاتصال QR المتصل.
 *
 * Both sweeps run in the background worker; a click only queues the job, so
 * the toast says "queued", not "done". Shown only for a connected QR link:
 * the history and pictures live in the company's own Evolution instance, and
 * a Cloud API connection has neither.
 */
export function WhatsAppSyncButtons() {
  const { t } = useI18n();
  const historySync = useRunEvolutionHistorySync();
  const avatarSync = useSyncEvolutionAvatars();

  /**
   * يحجز مهمة مزامنة ويُعلم المستخدم بالنتيجة.
   */
  async function queueSync(run: () => Promise<unknown>) {
    try {
      await run();
      toast.success(t("settings.integrations.evolutionSyncQueued"));
    } catch (error) {
      toast.error(describeError(error) ?? t("common.error"));
    }
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={historySync.isPending}
        onClick={() => void queueSync(() => historySync.mutateAsync())}
      >
        <History className={`size-4 ${historySync.isPending ? "animate-pulse" : ""}`} />
        {t("settings.integrations.evolutionSyncHistory")}
      </Button>
      <Button
        variant="outline"
        disabled={avatarSync.isPending}
        onClick={() => void queueSync(() => avatarSync.mutateAsync())}
      >
        <ImageDown className={`size-4 ${avatarSync.isPending ? "animate-pulse" : ""}`} />
        {t("settings.integrations.evolutionSyncAvatars")}
      </Button>
    </>
  );
}
