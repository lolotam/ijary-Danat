import { CheckCircle2, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirmPayment } from "@/hooks/useConfirmPayment";
import { useI18n } from "@/i18n/provider";

// The QR renderer is only ever needed by this dialog, on one screen, for one of
// three buttons. Loading it lazily keeps it out of the portal's main chunk.
const QRCodeSVG = lazy(() =>
  import("qrcode.react").then((module) => ({ default: module.QRCodeSVG })),
);

/** كم مرة نسأل البوابة عن حالة الدفع أثناء انتظار الهاتف. */
const POLL_INTERVAL_MS = 5_000;

/**
 * أقصى مدة انتظار قبل التوقف عن السؤال.
 *
 * A tenant who wanders off would otherwise leave a tab polling the gateway
 * forever. Ten minutes is past any realistic Apple Pay run, and the webhook plus
 * the `payment-reconcile` cron still settle the invoice after we stop looking.
 */
const POLL_TIMEOUT_MS = 10 * 60_000;

export interface ApplePayQrDialogProps {
  amountLabel: string;
  /** Called when Radix closes the dialog — Esc, the overlay, or the X. */
  onClose: () => void;
  paymentRequestCode: string;
  paymentUrl: string;
}

/**
 * يعرض رمز QR لصفحة Apple Pay ليمسحه المستأجر بهاتف الآيفون ويكمل الدفع عليه.
 *
 * Apple Pay only runs inside Safari on Apple hardware, so on a Windows or
 * Android desktop the button would otherwise be dead. The MyFatoorah
 * `PaymentURL` is an ordinary URL, so the phone that scans this opens the same
 * hosted page and pays there — no second gateway integration.
 *
 * The phone will not settle the payment on its own: it follows the redirect to
 * `/portal/payments/callback`, which needs a signed-in session the phone almost
 * certainly does not have. This desktop tab *is* signed in, so it polls
 * `confirmGatewayPayment` — which accepts a payment-request code without a
 * payment id — and settles on the phone's behalf.
 *
 * Mounting is what opens this, so there is no `open` prop: the caller renders it
 * only while a handoff exists and drops it on `onClose`. Carrying both a prop
 * and mount/unmount would leave two ways to close it and one of them untested.
 */
export function ApplePayQrDialog({
  amountLabel,
  onClose,
  paymentRequestCode,
  paymentUrl,
}: ApplePayQrDialogProps) {
  const { t } = useI18n();
  const confirmPayment = useConfirmPayment();
  const [settled, setSettled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  // Held in a ref so the polling effect does not restart every time the mutation
  // object changes identity, which would reset the interval on each tick.
  const confirmRef = useRef(confirmPayment);
  useEffect(() => {
    confirmRef.current = confirmPayment;
  }, [confirmPayment]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const interval = setInterval(() => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(interval);
        if (!cancelled) setTimedOut(true);
        return;
      }
      confirmRef.current
        .mutateAsync({ paymentRequestCode })
        .then((result) => {
          if (cancelled || result.status !== "paid") return;
          // useConfirmPayment already invalidates the portal's invoice, summary
          // and payment queries on a paid result, so the list behind this dialog
          // refreshes itself.
          clearInterval(interval);
          setSettled(true);
        })
        // A *pending* gateway state resolves above, not here — this only runs on
        // a real failure, so it is logged rather than silently dropped. Polling
        // continues anyway: a transient blip must not end the handoff, and the
        // timeout above is what stops it.
        .catch((error: unknown) => {
          console.error("Polling the Apple Pay handoff for settlement failed.", error);
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paymentRequestCode]);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("portal.applePayQr.title")}</DialogTitle>
          <DialogDescription>{t("portal.applePayQr.instructions")}</DialogDescription>
        </DialogHeader>

        {settled ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="size-12 text-emerald-600" aria-hidden="true" />
            <p className="font-bold">{t("portal.applePayQr.paid")}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            {/* ph-no-capture: the QR encodes the bearer payment link as SVG
                path geometry; session replay records a blank box instead. */}
            <div className="ph-no-capture rounded-xl bg-white p-4" dir="ltr">
              <Suspense
                fallback={<div className="size-[200px] animate-pulse rounded bg-slate-200" />}
              >
                <QRCodeSVG value={paymentUrl} size={200} marginSize={0} />
              </Suspense>
            </div>
            <p className="text-xl font-black">{amountLabel}</p>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {!timedOut && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {timedOut ? t("portal.applePayQr.timedOut") : t("portal.applePayQr.waiting")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
