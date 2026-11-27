import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { KeyRound, Lock } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";

/** بيانات الدخول إلى لوحة المشرف العام. */
const platformLoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(128),
});

export const Route = createFileRoute("/platform/login")({
  ssr: false,
  component: PlatformLoginPage,
});

/**
 * صفحة دخول المشرف العام.
 *
 * Signs in through the browser client directly: the shared identifier resolver
 * requires a request company and has no meaning on the platform host. The
 * roster is not queried here because `is_platform_admin()` demands `aal2` and
 * would refuse a genuine admin who has just entered a password; the layout
 * checks the roster once the second factor has raised the session to aal2.
 */
export function PlatformLoginPage() {
  const { t, dir } = useI18n();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * يتحقق من بيانات الدخول ثم يوجّه المشرف إلى العامل الثاني أو اللوحة.
   */
  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = platformLoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(t("platform.login.error.invalid"));
      return;
    }

    setSubmitting(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword(parsed.data);
      if (signInError || !data.session) {
        setError(t("platform.login.error.invalid"));
        return;
      }

      const { data: level, error: levelError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (levelError) {
        setError(t("platform.login.error.generic"));
        return;
      }

      void navigate({ to: level?.currentLevel === "aal2" ? "/platform" : "/platform/mfa" });
    } catch (error) {
      console.warn("[platform/login] sign-in failed", error);
      setError(t("platform.login.error.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div dir={dir} className="grid min-h-dvh place-items-center bg-ink px-4 py-10 text-white">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-7 text-foreground shadow-[var(--shadow-raised)]">
        <div className="flex items-start justify-between gap-3">
          <BrandLogo name={t("platform.title")} />
          <ThemeToggle />
        </div>
        <div className="mt-8 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <KeyRound className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t("platform.login.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("platform.login.subtitle")}</p>
          </div>
        </div>

        <form className="mt-7 grid gap-4" onSubmit={onSubmit}>
          <label htmlFor="platform-login-email" className="grid gap-1.5 text-sm font-medium">
            {t("platform.login.email")}
            <input
              id="platform-login-email"
              type="email"
              autoComplete="username"
              dir="ltr"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-[12px] border border-input bg-card px-3 py-2.5 outline-none focus:border-accent focus:ring-2 focus:ring-ring/25"
            />
          </label>
          <label htmlFor="platform-login-password" className="grid gap-1.5 text-sm font-medium">
            {t("platform.login.password")}
            <PasswordInput
              id="platform-login-password"
              autoComplete="current-password"
              dir="ltr"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-auto ps-3 py-2.5"
            />
          </label>
          {error && (
            <p
              className="rounded-[12px] border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={submitting} className="py-6">
            {submitting ? t("platform.login.submitting") : t("platform.login.submit")}
          </Button>
        </form>
        <p className="mt-5 flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
          <Lock className="mt-1 size-3.5 shrink-0" />
          {t("platform.login.note")}
        </p>
      </div>
    </div>
  );
}
