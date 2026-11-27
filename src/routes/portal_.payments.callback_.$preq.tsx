import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { confirmPaymentReturnPage, type PaymentReturnState } from "@/fns/paymentReturnPage";
import { useI18n } from "@/i18n/provider";

/**
 * يستخرج معرّف الدفعة من سلسلة الاستعلام دون الوثوق بأي حالة دفع في الرابط.
 */
function extractPaymentIdFromSearch(searchStr: string): string | undefined {
  if (!searchStr) return undefined;
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr : `?${searchStr}`);
  const candidate =
    params.get("paymentId") ??
    params.get("PaymentId") ??
    params.get("Id") ??
    params.get("id") ??
    undefined;
  const trimmed = candidate?.trim();
  return trimmed || undefined;
}

export const Route = createFileRoute("/portal_/payments/callback_/$preq")({
  ssr: false,
  loader: async ({ params, location }): Promise<PaymentReturnState> => {
    const paymentId = extractPaymentIdFromSearch(location.searchStr);
    try {
      return await confirmPaymentReturnPage({
        data: { paymentRequestCode: params.preq, paymentId },
      });
    } catch {
      return { status: "error", code: params.preq };
    }
  },
  component: PathPaymentCallbackPage,
});

/**
 * صفحة عودة الدفع الخالية من الجلسة والمقيّدة بشركة المضيف.
 *
 * Renders the confirmation outcome returned by the company-scoped server
 * loader without requiring a renter session (`contracts/webhooks.md`).
 */
function PathPaymentCallbackPage() {
  const { t, dir } = useI18n();
  const result = Route.useLoaderData();

  return (
    <main
      id="main-content"
      dir={dir}
      className="grid min-h-dvh place-items-center bg-muted/30 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold">{t("portal.callback.title")}</h1>
        <div className="mt-6 grid place-items-center gap-4">
          {result.status === "paid" && (
            <>
              <CheckCircle2 className="size-12 text-emerald-500" />
              <p className="font-medium">{t("portal.callback.paid")}</p>
              <p className="text-sm text-muted-foreground">{t("portal.callback.paidHint")}</p>
              <Button asChild size="lg" className="mt-2 pointer-coarse:min-h-11">
                <Link to="/portal/payments" search={{}}>
                  <ReceiptText className="size-4" />
                  {t("portal.callback.viewReceipt")}
                </Link>
              </Button>
            </>
          )}
          {result.status === "pending" && (
            <>
              <Clock3 className="size-12 text-amber-500" />
              <p className="font-medium">{t("portal.callback.pending")}</p>
            </>
          )}
          {(result.status === "failed" ||
            result.status === "not_found" ||
            result.status === "error") && (
            <>
              <XCircle className="size-12 text-destructive" />
              <p className="font-medium">
                {t(
                  result.status === "failed" ? "portal.callback.failed" : "portal.callback.unknown",
                )}
              </p>
            </>
          )}
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <Button asChild variant="outline" className="pointer-coarse:min-h-11">
              <Link to="/portal/invoices" search={{}}>
                {t("portal.callback.viewInvoices")}
              </Link>
            </Button>
            <Button asChild variant="ghost" className="pointer-coarse:min-h-11">
              <Link to="/portal/payments" search={{}}>
                {t("portal.callback.viewPayments")}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
