import { createFileRoute, Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { Building2, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { RequiredMark } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { usePortalIdentity } from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";

import { ThemeToggle } from "@/components/ThemeToggle";

const FALLBACK_BACKGROUND = "/landing/hero.png";

export const Route = createFileRoute("/portal_/auth")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    // Deep-link back into the portal after sign-in (e.g. the payment
    // callback). Restricted to portal paths so it can't become an open
    // redirect.
    typeof search.redirect === "string" && search.redirect.startsWith("/portal")
      ? { redirect: search.redirect }
      : {},
  head: () => ({
    meta: [{ title: "Tenant Portal — Danat Al Mustaqbal" }],
  }),
  component: PortalAuthPage,
});

/**
 * صفحة تسجيل دخول بوابة المستأجر.
 */
function PortalAuthPage() {
  const { t, dir, toggle } = useI18n();
  const { signInWithPassword, signOut, user, loading } = useAuth();
  const identity = usePortalIdentity();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const rootContext = useRouteContext({ from: "__root__" }) as
    | { branding?: { portalBgUrl?: string | null } }
    | undefined;
  const backgroundUrl = rootContext?.branding?.portalBgUrl || FALLBACK_BACKGROUND;
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only reject non-tenant accounts that signed in HERE; a staff session that
  // merely visits this page must not be silently signed out.
  const attemptedHere = useRef(false);

  useEffect(() => {
    if (loading || !user || !identity.data) return;
    if (identity.data.isTenant) {
      if (redirect) {
        window.location.assign(redirect);
      } else {
        navigate({ to: "/portal/payments", search: {} });
      }
      return;
    }
    if (attemptedHere.current) {
      attemptedHere.current = false;
      void signOut().then(() => {
        setSubmitting(false);
        setError(t("portalAuth.error.notTenant"));
      });
    }
  }, [identity.data, loading, navigate, redirect, signOut, t, user]);

  const isStaffSession = Boolean(user && identity.data?.isStaff && !identity.data.isTenant);

  /**
   * يرسّل بيانات الدخول ويخطر̈ رسالة الخطأ المناسبة لكل سبب فشل.
   */
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    attemptedHere.current = true;
    const { error: err } = await signInWithPassword(identifier, password);
    if (err) {
      attemptedHere.current = false;
      setSubmitting(false);
      setError(
        err === "ACCOUNT_DEACTIVATED"
          ? t("auth.error.deactivated")
          : err.toLowerCase().includes("invalid")
            ? t("auth.error.invalid")
            : t("auth.error.generic"),
      );
    }
    // On success the identity effect above redirects tenants or rejects
    // non-tenant accounts; keep the button disabled meanwhile.
  }

  const perks = [
    t("portalAuth.marketing.perk1"),
    t("portalAuth.marketing.perk2"),
    t("portalAuth.marketing.perk3"),
  ];

  return (
    <div dir={dir} className="relative min-h-dvh overflow-hidden bg-[#0e0d0b] text-white">
      <img
        src={backgroundUrl}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover opacity-50"
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(212,175,55,0.14),transparent_30rem),linear-gradient(110deg,rgba(14,13,11,0.72),rgba(14,13,11,0.96)_68%)]" />

      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-6">
        <BrandLogo name={t("brand.name")} onDark />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={toggle}
            className="min-h-10 pointer-coarse:min-h-11 rounded-full border border-white/20 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d4af37]"
          >
            {t("nav.language")}
          </button>
        </div>
      </header>

      <main
        id="main-content"
        className="relative z-10 mx-auto grid max-w-7xl items-center gap-12 px-5 pb-16 pt-8 lg:min-h-[calc(100dvh-6rem)] lg:grid-cols-[1.15fr_minmax(0,27rem)] lg:pt-0"
      >
        <section className="max-w-2xl py-8">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-[#d4af37]/30 bg-[#191919]/80 px-4 py-1.5 text-xs font-semibold tracking-[0.12em] text-[#f2cd60]">
            <Sparkles className="size-3.5" />
            {t("portalAuth.title")}
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-[1.02] tracking-[-0.04em] text-white sm:text-6xl">
            {t("portalAuth.marketing.headline")}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-8 text-white/70 sm:text-lg">
            {t("portalAuth.marketing.subline")}
          </p>
          <ul className="mt-9 grid max-w-xl gap-3">
            {perks.map((perk) => (
              <li
                key={perk}
                className="flex items-center gap-3 border-s-2 border-[#d4af37]/55 py-2 ps-4 text-sm font-medium leading-6 text-white/80"
              >
                <ShieldCheck className="size-4 shrink-0 text-[#f2cd60]" />
                {perk}
              </li>
            ))}
          </ul>
        </section>

        <section className="animate-in fade-in slide-in-from-bottom-6 duration-700 motion-reduce:animate-none lg:justify-self-end">
          <div className="w-full rounded-[24px] border border-[#d4af37]/20 bg-background p-7 text-foreground shadow-[var(--shadow-raised)] sm:p-8">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-xl bg-accent/10 text-accent">
                <Building2 className="size-5" />
              </div>
              <div>
                <h3 className="text-xl font-bold">{t("portalAuth.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("portalAuth.sub")}</p>
              </div>
            </div>

            <form className="mt-7 grid gap-4" onSubmit={onSubmit}>
              <div className="grid gap-1.5">
                <label htmlFor="identifier" className="text-sm font-medium text-foreground">
                  {t("auth.username")}
                  <RequiredMark />
                </label>
                <input
                  id="identifier"
                  type="text"
                  inputMode="text"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                  className="w-full rounded-[12px] border border-input bg-card px-3 py-2.5 text-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring/25"
                  dir="ltr"
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="password" className="text-sm font-medium text-foreground">
                  {t("auth.password")}
                  <RequiredMark />
                </label>
                <PasswordInput
                  id="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  // `ps-3` not `px-3`: the component reserves the trailing edge
                  // with `pe-10` for the toggle, and `px-*` would set the same
                  // physical side back to 0.75rem.
                  // `h-auto` cancels ui/input.tsx's h-9 so this keeps the card's
                  // taller field height and lines up with the username input.
                  className="h-auto w-full border-input bg-card ps-3 py-2.5 text-base text-foreground shadow-none outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring/25 md:text-base"
                  dir="ltr"
                />
              </div>
              {error && (
                <div
                  role="alert"
                  className="rounded-[12px] border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              {isStaffSession && (
                <div
                  role="status"
                  className="rounded-[12px] border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
                >
                  {t("portalAuth.staffNotice")}{" "}
                  <Link to="/admin" className="font-medium text-accent underline">
                    {t("portalAuth.staffNoticeCta")}
                  </Link>
                </div>
              )}
              <Button
                type="submit"
                disabled={submitting}
                className="mt-2 bg-[#171512] py-6 text-[#f5efe0]"
              >
                {submitting ? "…" : t("auth.submit")}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <Link
                to="/"
                className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline hover:text-accent"
              >
                {t("auth.backHome")}
              </Link>
            </div>
            <p className="mt-5 text-[11px] leading-5 text-muted-foreground">
              {t("portalAuth.note")}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
