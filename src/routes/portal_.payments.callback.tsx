import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Clock3, ReceiptText, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useConfirmPayment } from "@/hooks/useConfirmPayment";
import { usePortalIdentity } from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";

/**
 * Read payment identifiers from the raw query string first. Router search
 * parsing historically JSON.parsed values and corrupted long MyFatoorah IDs;
 * URLSearchParams always returns the original digit string from the redirect.
 */
function gatewayIdsFromSearch(search: Record<string, unknown>, pathPaymentRequestCode?: string) {
  const fromRaw =
    typeof window !== "undefined"
      ? (() => {
          const params = new URLSearchParams(window.location.search);
          const paymentId =
            params.get("paymentId") ??
            params.get("PaymentId") ??
            params.get("Id") ??
            params.get("id") ??
            undefined;
          const paymentRequestCode = params.get("preq") ?? params.get("PREQ") ?? undefined;
          return {
            paymentId: paymentId || undefined,
            paymentRequestCode: paymentRequestCode || undefined,
          };
        })()
      : { paymentId: undefined, paymentRequestCode: undefined };

  const coerce = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim()) return value.trim();
    // Number means precision may already be lost — only use as last resort.
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
    return undefined;
  };

  return {
    paymentId:
      fromRaw.paymentId ??
      coerce(search.paymentId) ??
      coerce(search.PaymentId) ??
      coerce(search.Id) ??
      coerce(search.id),
    paymentRequestCode:
      pathPaymentRequestCode ??
      fromRaw.paymentRequestCode ??
      coerce(search.preq) ??
      coerce(search.PREQ),
  };
}

// Deliberately outside the /portal layout: the gateway redirects here from a
// cross-site navigation, and the layout's auth guard can fire before the
// session is restored, losing the paymentId. This page waits for auth itself.
export const Route = createFileRoute("/portal_/payments/callback")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => gatewayIdsFromSearch(search),
  head: () => ({
    meta: [{ title: "Payment confirmation — Danat Al Mustaqbal" }],
  }),
  component: QueryPaymentCallbackPage,
});

type CallbackState = "checking" | "paid" | "pending" | "failed" | "missing" | "signin" | "error";

const CALLBACK_STATES: readonly CallbackState[] = [
  "checking",
  "paid",
  "pending",
  "failed",
  "missing",
  "signin",
  "error",
];

/**
 * تحمي حالة صفحة التأكيد من أي قيمة خارج الحالات السبع المعروفة — مثل رقم
 * HTTP يصل إلى `onSuccess` لو رمى الخادم `Response`، لأن TanStack Start
 * يسلّمها للعميل كنتيجة ناجحة (انظر `deleteAppUser.ts`). أي قيمة غير
 * معروفة تُرجَّح إلى "error" حتى لا تُعرَض على المستأجر صفحة فارغة بعد خصم البطاقة.
 */
function isCallbackState(value: unknown): value is CallbackState {
  return CALLBACK_STATES.includes(value as CallbackState);
}

function QueryPaymentCallbackPage() {
  return <PaymentCallbackPage search={Route.useSearch()} />;
}

/**
 * صفحة تأكيد الدفع بعد عودة بوابة الدفع: تنتظر الجلسة ثم تؤكد الدفع وتعرض النتيجة.
 *
 * Lives outside the /portal layout so the auth guard cannot fire before the
 * session is restored and drop the paymentId from the redirect.
 */
export function PaymentCallbackPage({
  paymentRequestCodeFromPath,
  search = {},
}: {
  paymentRequestCodeFromPath?: string;
  search?: Record<string, unknown>;
}) {
  const { t, dir } = useI18n();
  const { user, loading } = useAuth();
  const { paymentId, paymentRequestCode } = gatewayIdsFromSearch(
    search,
    paymentRequestCodeFromPath,
  );
  // The identity may not be ready on the first render; useConfirmPayment reads
  // it as a snapshot and only invalidates the portal caches when both fields
  // are populated.
  const identity = usePortalIdentity();
  const confirmPayment = useConfirmPayment();
  const [state, setState] = useState<CallbackState>(
    paymentId || paymentRequestCode ? "checking" : "missing",
  );
  const [confirmedTenantId, setConfirmedTenantId] = useState<string | null>(null);
  const confirmStarted = useRef(false);

  useEffect(() => {
    // Re-read raw URL on mount in case validateSearch ran before hydration.
    const raw = gatewayIdsFromSearch({}, paymentRequestCodeFromPath);
    const resolvedPaymentId = paymentId ?? raw.paymentId;
    const resolvedPreq = paymentRequestCode ?? raw.paymentRequestCode;
    if ((!resolvedPaymentId && !resolvedPreq) || loading || confirmStarted.current) return;
    if (!user) {
      setState("signin");
      return;
    }
    confirmStarted.current = true;
    setState("checking");
    confirmPayment.mutate(
      {
        paymentId: resolvedPaymentId,
        paymentRequestCode: resolvedPreq,
      },
      {
        onSuccess: (result) => {
          setConfirmedTenantId(result.tenantId);
          setState(isCallbackState(result.status) ? result.status : "error");
        },
        onError: () => setState("error"),
      },
    );
  }, [confirmPayment, loading, paymentId, paymentRequestCode, paymentRequestCodeFromPath, user]);

  const callbackPath = paymentRequestCode
    ? `/portal/payments/callback/${encodeURIComponent(paymentRequestCode)}`
    : "/portal/payments/callback";
  const redirectSearch = new URLSearchParams(paymentId ? { paymentId } : {});
  const redirectTarget = redirectSearch.size ? `${callbackPath}?${redirectSearch}` : callbackPath;
  const portalSearch =
    identity.data?.isStaff && confirmedTenantId ? { tenant: confirmedTenantId } : {};

  return (
    <main
      id="main-content"
      dir={dir}
      className="grid min-h-dvh place-items-center bg-muted/30 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold">{t("portal.callback.title")}</h1>
        <div className="mt-6 grid place-items-center gap-4">
          {state === "checking" && (
            <>
              <Clock3 className="size-12 animate-pulse text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("portal.callback.checking")}</p>
            </>
          )}
          {state === "signin" && (
            <>
              <Clock3 className="size-12 text-muted-foreground" />
              <p className="font-medium">{t("portal.callback.signin")}</p>
              <Button asChild className="pointer-coarse:min-h-11">
                <Link to="/portal/auth" search={{ redirect: redirectTarget }}>
                  {t("portal.callback.signinCta")}
                </Link>
              </Button>
            </>
          )}
          {state === "paid" && (
            <>
              <CheckCircle2 className="size-12 text-emerald-500" />
              <p className="font-medium">{t("portal.callback.paid")}</p>
              <p className="text-sm text-muted-foreground">{t("portal.callback.paidHint")}</p>
            </>
          )}
          {state === "pending" && (
            <>
              <Clock3 className="size-12 text-amber-500" />
              <p className="font-medium">{t("portal.callback.pending")}</p>
            </>
          )}
          {(state === "failed" || state === "error" || state === "missing") && (
            <>
              <XCircle className="size-12 text-destructive" />
              <p className="font-medium">
                {t(state === "failed" ? "portal.callback.failed" : "portal.callback.unknown")}
              </p>
            </>
          )}
          {state === "paid" && (
            <Button asChild size="lg" className="mt-2 pointer-coarse:min-h-11">
              {/* The receipt is the user-facing "invoice" they can download.
                  It now lives on My Payments — each row carries Preview, Print
                  and Download actions — since the separate receipts section was
                  removed as a duplicate of exactly that. */}
              <Link to="/portal/payments" search={portalSearch}>
                <ReceiptText className="size-4" />
                {t("portal.callback.viewReceipt")}
              </Link>
            </Button>
          )}
          {state !== "checking" && state !== "signin" && (
            <div className="mt-2 flex flex-wrap justify-center gap-3">
              <Button asChild variant="outline" className="pointer-coarse:min-h-11">
                <Link to="/portal/invoices" search={portalSearch}>
                  {t("portal.callback.viewInvoices")}
                </Link>
              </Button>
              <Button asChild variant="ghost" className="pointer-coarse:min-h-11">
                <Link to="/portal/payments" search={portalSearch}>
                  {t("portal.callback.viewPayments")}
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
