import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound } from "lucide-react";
import { useState } from "react";

import {
  ChangePasswordForm,
  type ChangePasswordPayload,
} from "@/components/auth/ChangePasswordForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changeOwnPassword, confirmPasswordReset, requestPasswordReset } from "@/fns/passwordReset";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";

/**
 * شاشة إعادة تعيين كلمة المرور وتغييرها الإجباري.
 *
 * One screen, three situations, told apart by the link that opened it:
 *
 * - no parameters — the person asks for a reset link (the answer is the same
 *   whether or not the account exists);
 * - `?token=…` — the link from the email, where the new password is set;
 * - `?change=1` — the forced change of a temporary password, sent here by the
 *   route guard of the admin panel and the renter portal (FR-032).
 *
 * `next` says where to go once the password is changed. It is checked against
 * a fixed list, so a crafted link cannot turn this page into an open redirect.
 */

/**
 * الوجهة التي يعود إليها المستخدم بعد التغيير الإجباري؛ يمرّرها حارس المسار.
 *
 * The list is a closed one: a destination read from the URL is only honoured
 * when it is in it, so a crafted link cannot turn this page into an open
 * redirect.
 */
const DESTINATIONS = ["/admin", "/portal"] as const;

/** وجهة يُنتقل إليها بعد تغيير كلمة المرور. */
type ResetDestination = (typeof DESTINATIONS)[number];

/** صفحة الدخول التي يذهب إليها من غيّر كلمة مروره برابط البريد. */
type SignInPath = "/auth" | "/portal/auth";

interface ResetPasswordSearch {
  token?: string;
  change?: "1" | "self";
  next?: ResetDestination;
}

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
    token: typeof search.token === "string" && search.token.length > 0 ? search.token : undefined,
    change: search.change === "1" || search.change === "self" ? search.change : undefined,
    next: DESTINATIONS.includes(search.next as ResetDestination)
      ? (search.next as ResetDestination)
      : undefined,
  }),
  component: ResetPasswordPage,
});

/**
 * صفحة إعادة تعيين كلمة المرور أو تغيير كلمة المرور المؤقتة عند أول دخول.
 */
function ResetPasswordPage() {
  const { t, dir } = useI18n();
  const { token, change, next } = Route.useSearch();
  const requestReset = useServerFn(requestPasswordReset);
  const confirmReset = useServerFn(confirmPasswordReset);
  const changeOwn = useServerFn(changeOwnPassword);

  const [identifier, setIdentifier] = useState("");
  const [sending, setSending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [changed, setChanged] = useState(false);
  const [needsCurrentPassword, setNeedsCurrentPassword] = useState(false);
  // Where the person signs in after a reset: a renter's account lives on the
  // portal, a staff account on the console.
  const [portalAccount, setPortalAccount] = useState(false);

  const forced = !token && change === "1";
  const voluntaryChange = !token && change === "self";
  const ownChange = forced || voluntaryChange;
  const requireCurrentPassword = voluntaryChange || needsCurrentPassword;

  /**
   * يطلب رابط إعادة التعيين ويعرض الجملة العامة التي لا تكشف وجود الحساب.
   */
  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    try {
      await requestReset({ data: { identifier } });
    } catch (error) {
      console.error("[password-reset] requesting a reset link failed:", error);
    }
    setSending(false);
    setRequested(true);
  }

  /**
   * يستهلك رمز الرابط البريدي ويضع كلمة المرور الجديدة.
   */
  async function submitTokenPassword({ password }: ChangePasswordPayload): Promise<string | null> {
    try {
      const result = await confirmReset({ data: { token: token!, password } });
      if (result.ok) {
        setPortalAccount(result.portalAccount);
        setChanged(true);
        return null;
      }
      return t("passwordReset.invalidToken");
    } catch (error) {
      console.error("[password-reset] confirming the reset token failed:", error);
      return t("passwordReset.failed");
    }
  }

  /**
   * يغيّر كلمة المرور لحساب مسجّل دخوله، ثم يُنهي الجلسة المحلية ليعيد تسجيل الدخول.
   */
  async function submitOwnPassword({
    currentPassword,
    password,
  }: ChangePasswordPayload): Promise<string | null> {
    try {
      const result = await changeOwn({ data: { currentPassword, password } });
      if (!result.ok) {
        if (result.error === "INVALID_CREDENTIALS") {
          if (!currentPassword) {
            setNeedsCurrentPassword(true);
            return t("passwordReset.currentPasswordRequired");
          }
          return t("passwordReset.invalidCurrentPassword");
        }
        return t("passwordReset.failed");
      }
      setPortalAccount(next === "/portal");
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      setChanged(true);
      return null;
    } catch (error) {
      console.error("[password-reset] changing the password failed:", error);
      return t("passwordReset.failed");
    }
  }

  const title = forced
    ? t("passwordReset.forced.title")
    : token || voluntaryChange
      ? t("passwordReset.change.title")
      : t("passwordReset.request.title");
  const description = forced
    ? t("passwordReset.forced.description")
    : token || voluntaryChange
      ? t("passwordReset.change.description")
      : t("passwordReset.request.description");

  const signInPath: SignInPath = portalAccount ? "/portal/auth" : "/auth";

  return (
    <div dir={dir} className="grid min-h-dvh place-items-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-6">
          <header className="space-y-2 text-center">
            <KeyRound className="mx-auto size-10 text-primary" aria-hidden="true" />
            <h1 className="text-xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </header>

          {changed ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-emerald-700">{t("passwordReset.changed")}</p>
              <Button asChild className="w-full">
                <Link to={signInPath}>{t("passwordReset.signIn")}</Link>
              </Button>
            </div>
          ) : null}

          {!changed && ownChange ? (
            <ChangePasswordForm
              requireCurrentPassword={requireCurrentPassword}
              onSubmit={submitOwnPassword}
            />
          ) : null}

          {!changed && !ownChange && token ? (
            <ChangePasswordForm onSubmit={submitTokenPassword} />
          ) : null}

          {!changed && !ownChange && !token ? (
            <div className="space-y-4">
              {requested ? (
                <p className="text-sm text-muted-foreground">{t("passwordReset.request.sent")}</p>
              ) : (
                <form className="grid gap-4" onSubmit={submitRequest}>
                  <div className="grid gap-2">
                    <Label htmlFor="identifier">{t("passwordReset.request.identifier")}</Label>
                    <Input
                      id="identifier"
                      name="identifier"
                      autoComplete="username"
                      value={identifier}
                      onChange={(event) => setIdentifier(event.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={sending} className="w-fit">
                    {sending ? t("common.loading") : t("passwordReset.request.submit")}
                  </Button>
                </form>
              )}
              <Button asChild variant="outline" className="w-full">
                <Link to="/auth">{t("passwordReset.signIn")}</Link>
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
