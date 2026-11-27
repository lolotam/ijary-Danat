import { ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import {
  endSupportSessionFromPanel,
  readSupportSessionContext,
  supportSessionErrorMessage,
  type SupportSessionContext,
} from "@/platform/supportSessionFns";

/**
 * شريط أحمر دائم في غلاف الإدارة ما دامت جلسة الدعم الفني مفتوحة.
 *
 * The banner is the company's own notice that a platform admin is inside its
 * panel (FR-071): it names who entered, why, and how to end it. It is never
 * dismissible — the session ends when the super admin ends it, not when the
 * person reading the panel chooses to hide the notice.
 */
export function SupportSessionBanner() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const [context, setContext] = useState<SupportSessionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const accessToken = session?.access_token;

  useEffect(() => {
    let active = true;
    if (!accessToken) {
      setContext(null);
      return;
    }

    void readSupportSessionContext()
      .then((loaded) => {
        if (active) setContext(loaded);
      })
      .catch((cause: unknown) => {
        // A read that fails hides the banner instead of showing a broken
        // state: the database refusing the read means the session grants
        // nothing anyway. The failure is logged, not hidden.
        console.warn("[support-session] reading the session context failed:", cause);
        if (active) setContext(null);
      });

    return () => {
      active = false;
    };
  }, [accessToken]);

  /**
   * ينهي جلسة الدعم ويخرج من جلسة الشركة.
   */
  async function handleEnd() {
    setEnding(true);
    setError(null);
    try {
      await endSupportSessionFromPanel();
      setContext(null);
      // The session is over but the browser still holds it, so it is dropped:
      // the panel refuses every request from here on, and its layout sends
      // the visitor back to the sign-in page.
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        console.warn(
          "[support-session] signing out after the session ended failed:",
          signOutError.message,
        );
      }
    } catch (cause) {
      setError(supportSessionErrorMessage(t, cause));
    } finally {
      setEnding(false);
    }
  }

  if (!context?.active) return null;

  const byline = t("supportSession.banner.by").replace("{name}", context.adminName);
  const reason = t("supportSession.banner.reason").replace("{reason}", context.reason);
  const expires = t("supportSession.banner.expiresAt").replace(
    "{time}",
    new Date(context.expiresAt).toLocaleString(locale),
  );

  return (
    <Alert className="rounded-none border-x-0 border-t-0 border-b border-destructive/50 bg-destructive/10 px-4 py-2.5 text-destructive dark:bg-destructive/20 sm:px-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <AlertDescription className="min-w-0 space-y-0.5 text-xs leading-relaxed sm:text-sm">
            <p className="font-medium">{t("supportSession.banner.title")}</p>
            <p>{byline}</p>
            <p>{reason}</p>
            <p>{expires}</p>
            {error ? <p className="text-destructive">{error}</p> : null}
          </AlertDescription>
        </div>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={ending}
          data-testid="support-session-end"
          onClick={() => void handleEnd()}
        >
          {ending ? t("supportSession.banner.ending") : t("supportSession.banner.end")}
        </Button>
      </div>
    </Alert>
  );
}
