import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { CompanyHealthTable } from "@/components/platform/CompanyHealthTable";
import { OverviewTotals } from "@/components/platform/OverviewTotals";
import { useI18n } from "@/i18n/provider";
import type { PlatformOverview } from "@/platform/overview";
import { fetchPlatformOverview } from "@/platform/overviewFns";
import { platformErrorMessage } from "@/platform/platformFns";

export const Route = createFileRoute("/platform/")({
  ssr: false,
  component: PlatformOverviewPage,
});

/**
 * شاشة النظرة العامة على المنصة: إجمالياتها وحالة كل شركة (قصة المستخدم 12).
 *
 * The screen reads one server call that returns both the totals and the
 * health of every company: two calls would show a total that belongs to one
 * moment and a health list that belongs to another.
 */
export function PlatformOverviewPage() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** يقرأ حالة المنصة من الخادم. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchPlatformOverview();
      setOverview(result);
      setError(null);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("platform.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("platform.subtitle")}</p>
      </header>

      <OverviewTotals totals={overview?.totals ?? null} loading={loading} error={error} />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("platformOverview.health.title")}</h2>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <CompanyHealthTable rows={overview?.companies ?? []} loading={loading} error={error} />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/platform/companies"
          className="rounded-xl border border-border bg-card p-5 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          {t("platform.nav.companies")}
        </Link>
        <Link
          to="/platform/audit"
          className="rounded-xl border border-border bg-card p-5 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          {t("platform.nav.audit")}
        </Link>
      </div>
    </section>
  );
}
