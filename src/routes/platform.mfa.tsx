import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";

/** رمز TOTP صالح دائماً ستة أرقام. */
const codeSchema = z.string().regex(/^\d{6}$/);

/** بيانات تسجيل عامل جديد كما تُعرض للمستخدم مرة واحدة. */
interface Enrollment {
  factorId: string;
  secret: string;
  qrCode: string;
}

export const Route = createFileRoute("/platform/mfa")({
  ssr: false,
  component: PlatformMfaPage,
});

/**
 * شاشة إجبار العامل الثاني لمشرفي المنصة.
 *
 * A verified TOTP factor is challenged; an unverified leftover is removed and
 * replaced with a fresh enrollment. No platform child route renders above this
 * screen, so an admin without a second factor cannot reach company data.
 */
export function PlatformMfaPage() {
  const { user, loading, signOut } = useAuth();
  const { t, dir } = useI18n();
  const navigate = useNavigate();
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  const [verifiedFactorId, setVerifiedFactorId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id;

  useEffect(() => {
    if (loading) return;
    if (!userId) {
      void navigate({ to: "/platform/login" });
      return;
    }
    if (started.current) return;
    started.current = true;

    /**
     * يحضّر عاملاً مؤكداً للتحقق أو ينشئ تسجيلاً جديداً لمن لم يملك عاملاً.
     */
    async function prepareFactor() {
      try {
        const { data, error: listError } = await supabase.auth.mfa.listFactors();
        if (listError) throw listError;

        const factors = data?.all ?? [];
        const unverified = factors.filter(
          (factor) => factor.factor_type === "totp" && factor.status !== "verified",
        );
        for (const factor of unverified) {
          const { error: unenrollError } = await supabase.auth.mfa.unenroll({
            factorId: factor.id,
          });
          if (unenrollError) throw unenrollError;
        }

        const verified = factors.find(
          (factor) => factor.factor_type === "totp" && factor.status === "verified",
        );
        if (verified) {
          setVerifiedFactorId(verified.id);
          setReady(true);
          return;
        }

        const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: "IJARY",
        });
        if (enrollError || !enrolled?.totp) {
          throw enrollError ?? new Error("MFA enrollment returned no TOTP secret");
        }

        setEnrollment({
          factorId: enrolled.id,
          secret: enrolled.totp.secret,
          qrCode: enrolled.totp.qr_code,
        });
        setReady(true);
      } catch (cause) {
        console.warn("[platform/mfa] factor preparation failed", cause);
        setError(t("platform.mfa.error.generic"));
        started.current = false;
      }
    }

    void prepareFactor();
  }, [loading, navigate, t, userId]);

  /**
   * يتحقق من الرمز ويجعل الجلسة تنتقل إلى مستوى العامل الثاني.
   */
  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = codeSchema.safeParse(code);
    if (!parsed.success) {
      setError(t("platform.mfa.error.code"));
      return;
    }

    const factorId = enrollment?.factorId ?? verifiedFactorId;
    if (!factorId) {
      throw new Error("No TOTP factor is ready for verification");
    }

    setBusy(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError || !challenge?.id) throw challengeError ?? new Error("No MFA challenge");

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: parsed.data,
      });
      if (verifyError) throw verifyError;

      void navigate({ to: "/platform" });
    } catch (cause) {
      console.warn("[platform/mfa] verification failed", cause);
      setError(t("platform.mfa.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div dir={dir} className="mx-auto grid min-h-dvh max-w-lg place-items-center px-4 py-10">
      <section className="w-full rounded-xl border border-border bg-card p-7 shadow-[var(--shadow-raised)]">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-accent/10 text-accent">
            <ShieldCheck className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t("platform.mfa.title")}</h1>
            <p className="text-xs text-muted-foreground">{t("platform.mfa.subtitle")}</p>
          </div>
        </div>

        {!ready ? (
          <p className="mt-7 text-sm text-muted-foreground" role="status">
            {t("platform.loading")}
          </p>
        ) : (
          <>
            {enrollment ? (
              <div className="mt-7 space-y-3">
                <p className="text-sm leading-6">{t("platform.mfa.enrollHint")}</p>
                <img
                  src={enrollment.qrCode}
                  alt={t("platform.mfa.scan")}
                  className="size-44 rounded-lg border border-border bg-white p-2"
                />
                <p className="text-xs text-muted-foreground">
                  {t("platform.mfa.secret")}:{" "}
                  <code dir="ltr" className="select-all font-mono text-sm text-foreground">
                    {enrollment.secret}
                  </code>
                </p>
              </div>
            ) : (
              <p className="mt-7 text-sm leading-6">{t("platform.mfa.verifiedHint")}</p>
            )}

            <form className="mt-6 grid gap-4" onSubmit={onSubmit}>
              <label htmlFor="platform-mfa-code" className="grid gap-1.5 text-sm font-medium">
                {t("platform.mfa.code")}
                <input
                  id="platform-mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  dir="ltr"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  className="w-full rounded-[12px] border border-input bg-background px-3 py-2.5 font-mono tracking-[0.3em] outline-none focus:border-accent focus:ring-2 focus:ring-ring/25"
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
              <Button type="submit" disabled={busy} className="py-6">
                {busy ? t("platform.mfa.submitting") : t("platform.mfa.submit")}
              </Button>
            </form>
          </>
        )}

        <Button
          type="button"
          variant="ghost"
          className="mt-5 w-full"
          onClick={async () => {
            await signOut();
            void navigate({ to: "/platform/login" });
          }}
        >
          {t("platform.mfa.signOut")}
        </Button>
      </section>
    </div>
  );
}
