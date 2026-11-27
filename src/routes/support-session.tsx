import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import { acceptSupportSessionToken } from "@/platform/supportSessionFns";

/**
 * صفحة دخول جلسة الدعم على مضيف الشركة: تقرأ رمز الجلسة من جزء العنوان،
 * وتمسحه من شريط العنوان، ثم تفتح جلسة الشركة بحساب الموظف المستهدف.
 *
 * The token travels in the fragment on purpose: a fragment is never sent to
 * the server, so it stays out of the access logs and out of the referrer of
 * the page it opens. The server decides whether the token may open a session
 * here — a token for another company is refused with the same answer as an
 * invalid one, and nothing about the other company is revealed.
 */

/**
 * قيمة رمز التجديد في جلسة الدعم: لا يوجد رمز تجديد حقيقي.
 *
 * The client refuses a session without a refresh token, so the impersonation
 * token stands in for one. It is not a GoTrue refresh token and can never be
 * exchanged, so the session ends with the token itself instead of being
 * renewed past the sixty minutes the platform allows.
 */
const NO_REFRESH_TOKEN = "support-session-no-refresh";
/** حالة صفحة الدخول إلى جلسة الدعم. */
type SupportSessionPageState = "opening" | "refused" | "no_token";

export const Route = createFileRoute("/support-session")({
  ssr: false,
  component: SupportSessionPage,
});

/**
 * يقرأ رمز الجلسة من جزء العنوان، أو يعيد null إن لم يكن فيه رمز.
 */
function readTokenFromFragment(): string | null {
  const fragment = window.location.hash.replace(/^#/, "");
  if (!fragment) return null;
  return new URLSearchParams(fragment).get("token");
}

/**
 * يمسح جزء العنوان من شريط العنوان ومن سجل المتصفح.
 *
 * The token is out of the address bar before the session opens, so it is not
 * copied by accident and not carried into the next page as a referrer.
 */
function clearFragment(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * يفتح جلسة الشركة من رمز جلسة الدعم، أو يرفض الطلب.
 *
 * The server has already decided that the token may open a session on this
 * host, so the browser only installs it: the token becomes the Supabase
 * session and the company panel opens with it.
 */
async function openSupportSession(token: string): Promise<boolean> {
  const result = await acceptSupportSessionToken({ token });
  if (!result.accepted) return false;

  const { error } = await supabase.auth.setSession({
    access_token: token,
    refresh_token: NO_REFRESH_TOKEN,
  });
  return error === null;
}

/**
 * صفحة دخول جلسة الدعم: تفتح جلسة الشركة أو ترفض الطلب دون أن تكشف أي شيء.
 */
function SupportSessionPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [state, setState] = useState<SupportSessionPageState>("opening");

  useEffect(() => {
    let cancelled = false;

    /**
     * يقرأ الرمز، ويطلب قبوله من الخادم، ثم يفتح جلسة الشركة.
     */
    async function openSession() {
      try {
        const token = readTokenFromFragment();
        clearFragment();
        if (!token) {
          setState("no_token");
          return;
        }

        const opened = await openSupportSession(token);
        if (cancelled) return;
        if (!opened) {
          setState("refused");
          return;
        }

        await navigate({ to: "/admin" });
      } catch (error) {
        // A refused or unreachable server ends in the same answer: the page
        // says the session did not open, and says nothing about why.
        console.error("[support-session] opening the session failed:", error);
        if (!cancelled) setState("refused");
      }
    }

    void openSession();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("supportSession.route.title")}
        </h1>

        {state === "opening" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("supportSession.route.opening")}
          </p>
        ) : null}

        {state === "refused" ? (
          <p className="text-sm text-destructive" role="alert">
            {t("supportSession.route.refused")}
          </p>
        ) : null}

        {state === "no_token" ? (
          <p className="text-sm text-destructive" role="alert">
            {t("supportSession.route.noToken")}
          </p>
        ) : null}

        {state === "opening" ? null : (
          <Button type="button" variant="outline" onClick={() => void navigate({ to: "/auth" })}>
            {t("supportSession.route.signIn")}
          </Button>
        )}
      </div>
    </main>
  );
}
