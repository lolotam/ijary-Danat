import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AuditTable } from "@/components/platform/AuditTable";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { listPlatformAudit, PLATFORM_AUDIT_PAGE_SIZE } from "@/platform/auditList";
import type { PlatformAuditLogRow } from "@/integrations/supabase/database.types";

export const Route = createFileRoute("/platform/audit")({
  ssr: false,
  component: PlatformAuditPage,
});

/**
 * شاشة سجل تدقيق المنصة: صفحة واحدة في كل مرة، بترتيب الأحدث أولاً.
 *
 * The read goes through the browser client so PostgREST applies the
 * `is_platform_admin()` policy to the same JWT the layout checked. The total
 * comes from PostgREST's exact count, never from the length of the current
 * page, so the pager cannot claim a next page that does not exist.
 */
export function PlatformAuditPage() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PlatformAuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);

    /** يقرأ الصفحة الحالية ويتجاهل نتيجة أي صفحة لم تعد معروضة. */
    async function loadPage() {
      try {
        const result = await listPlatformAudit({ page });
        if (!active) return;
        setRows(result.rows);
        setTotal(result.total);
        setError(null);
      } catch (cause) {
        console.warn("[platform/audit] page read failed", cause);
        if (!active) return;
        setRows([]);
        setTotal(0);
        setError(t("platform.audit.error"));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadPage();
    return () => {
      active = false;
    };
  }, [page, t]);

  const pageCount = Math.max(1, Math.ceil(total / PLATFORM_AUDIT_PAGE_SIZE));

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("platform.audit.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("platform.audit.subtitle")}</p>
      </header>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <AuditTable rows={rows} loading={loading} error={error} />
      </div>

      <nav
        aria-label={t("platform.audit.title")}
        className="flex items-center justify-between gap-3 text-sm"
      >
        <Button
          type="button"
          variant="outline"
          disabled={loading || page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          {t("platform.audit.previous")}
        </Button>
        <span className="tabular-nums text-muted-foreground">
          {t("platform.audit.page")} {page} {t("platform.audit.of")} {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={loading || page >= pageCount}
          onClick={() => setPage((current) => current + 1)}
        >
          {t("platform.audit.next")}
        </Button>
      </nav>
    </section>
  );
}
