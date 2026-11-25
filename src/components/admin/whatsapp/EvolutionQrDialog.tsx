import { useEffect, useRef, useState } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEvolutionQrStatus, useRefreshEvolutionQr } from "@/hooks/useEvolutionConnection";
import { useI18n } from "@/i18n/provider";

/** QR validity window shown to the admin; WhatsApp rotates codes around this. */
const QR_EXPIRY_SECONDS = 45;
/** Delay before closing so the admin sees the success state. */
const CLOSE_AFTER_CONNECT_MS = 1500;

interface EvolutionQrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** First QR returned by beginEvolutionSession, shown before the first poll lands. */
  initialQr: string | null;
}

/**
 * حوار مسح رمز QR لاقتران واتساب: يعرض الرمز، يستطلع الحالة كل ثانيتين،
 * ويتحوّل إلى بطاقة نجاح عند تمام الاقتران.
 *
 * The poll (useEvolutionQrStatus) is the single source of truth once open; the
 * initial QR only bridges the gap before the first poll returns. The countdown
 * is client-side UX — the server clears the stored QR itself once the session
 * opens, so an expired display never means an expired session.
 */
export function EvolutionQrDialog({ open, onOpenChange, initialQr }: EvolutionQrDialogProps) {
  const { t } = useI18n();
  const status = useEvolutionQrStatus(open);
  const refresh = useRefreshEvolutionQr();
  const [secondsLeft, setSecondsLeft] = useState(QR_EXPIRY_SECONDS);
  const closeReported = useRef(false);

  const qr = status.data?.qr ?? initialQr;
  const state = status.data?.state ?? null;
  const isConnected = state === "open";

  // Restart the countdown whenever a different QR arrives (webhook-pushed or
  // manually refreshed), and reset bookkeeping when the dialog reopens.
  useEffect(() => {
    setSecondsLeft(QR_EXPIRY_SECONDS);
  }, [qr]);

  useEffect(() => {
    if (!open) {
      closeReported.current = false;
      return;
    }
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !isConnected || closeReported.current) return;
    closeReported.current = true;
    toast.success(t("settings.integrations.evolutionConnected"));
    const timer = window.setTimeout(() => onOpenChange(false), CLOSE_AFTER_CONNECT_MS);
    return () => window.clearTimeout(timer);
  }, [open, isConnected, onOpenChange, t]);

  async function onRefreshQr() {
    try {
      await refresh.mutateAsync();
      setSecondsLeft(QR_EXPIRY_SECONDS);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  const expired = secondsLeft === 0 && !isConnected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.integrations.evolutionScanTitle")}</DialogTitle>
          <DialogDescription>{t("settings.integrations.evolutionScanHint")}</DialogDescription>
        </DialogHeader>

        {isConnected ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-green-600/30 bg-green-600/10 p-6">
            <CheckCircle2 className="size-10 text-green-600" />
            <p className="text-sm font-medium">{t("settings.integrations.evolutionConnected")}</p>
          </div>
        ) : expired || !qr ? (
          <div className="flex flex-col items-center gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              {expired ? t("settings.integrations.evolutionQrExpired") : t("common.loading")}
            </p>
            <Button variant="outline" disabled={refresh.isPending} onClick={onRefreshQr}>
              <RefreshCw className={`size-4 ${refresh.isPending ? "animate-spin" : ""}`} />
              {t("settings.integrations.evolutionRefreshQr")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            {/* ph-no-capture: the QR is a live WhatsApp pairing credential, so
                session replay records a blank box of the same size instead. */}
            <img
              src={qr.startsWith("data:image/") ? qr : `data:image/png;base64,${qr}`}
              alt={t("settings.integrations.evolutionScanTitle")}
              className="ph-no-capture size-64 rounded-md border bg-white p-2"
            />
            <p className="text-xs text-muted-foreground" dir="ltr">
              {secondsLeft}s
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
