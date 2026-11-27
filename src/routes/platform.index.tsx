import { createFileRoute, Link } from "@tanstack/react-router";

import { useI18n } from "@/i18n/provider";

export const Route = createFileRoute("/platform/")({
  ssr: false,
  component: PlatformOverview,
});

/**
 * الصفحة الأولى للوحة المشرف العام بعد اكتمال بوابة الجلسة.
 *
 * It contains no company counters yet (US12): those need the cross-company
 * read functions of a later slice, and inventing totals here would give the
 * super admin a dashboard that looks authoritative but is not.
 */
export function PlatformOverview() {
  const { t } = useI18n();

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("platform.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("platform.subtitle")}</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/platform/audit"
          className="rounded-xl border border-border bg-card p-5 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          {t("platform.nav.audit")}
        </Link>
        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          {t("platform.nav.overview")}
        </div>
      </div>
    </section>
  );
}
