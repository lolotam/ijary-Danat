import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CompaniesTable } from "@/components/platform/CompaniesTable";
import { CompanyCreateDialog } from "@/components/platform/CompanyCreateDialog";
import { RenewalWarnings } from "@/components/platform/RenewalWarnings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import type { PlatformCompanySummary } from "@/platform/companies";
import { fetchPlatformCompanies, platformErrorMessage } from "@/platform/platformFns";

/** عدد الشركات في الصفحة الواحدة. */
const PAGE_SIZE = 25;

/** حالات الشركة التي يفلتر بها المشرف العام. */
const STATUS_FILTERS = ["all", "active", "suspended"] as const;

/** حالة الشركة التي يفلتر بها المشرف العام. */
type StatusFilter = (typeof STATUS_FILTERS)[number];

export const Route = createFileRoute("/platform/companies/")({
  ssr: false,
  component: PlatformCompaniesPage,
});

/**
 * شاشة شركات المنصة: بحث، وتصفية بالحالة، وتقسيم الصفحات.
 *
 * The search is applied when the form is submitted rather than on every
 * keystroke: a query per letter would put a read on the wire for every
 * character the super admin types.
 */
export function PlatformCompaniesPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<PlatformCompanySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  /** يقرأ صفحة الشركات بالفلاتر المطبّقة. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchPlatformCompanies({
        status: status === "all" ? undefined : status,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setRows(result.rows);
      setTotal(result.count);
      setError(null);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setLoading(false);
    }
  }, [page, search, status, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** يطبّق البحث ويعود إلى الصفحة الأولى. */
  function applySearch(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  /** يغيّر حالة الشركة المفلترة، ويعود إلى الصفحة الأولى. */
  function applyStatus(next: StatusFilter) {
    setPage(1);
    setStatus(next);
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t("platformCompaniesUi.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("platformCompaniesUi.subtitle")}</p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden />
          {t("platformCompaniesUi.create")}
        </Button>
      </header>

      <form className="flex flex-wrap items-end gap-3" onSubmit={applySearch}>
        <div className="grid min-w-64 flex-1 gap-1.5">
          <Label htmlFor="platform-companies-search">{t("platformCompaniesUi.search")}</Label>
          <Input
            id="platform-companies-search"
            value={searchInput}
            placeholder={t("platformCompaniesUi.searchPlaceholder")}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="platform-companies-status">{t("platformCompaniesUi.filter.label")}</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              const match = STATUS_FILTERS.find((filter) => filter === value);
              if (match) applyStatus(match);
            }}
          >
            <SelectTrigger id="platform-companies-status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("platformCompaniesUi.filter.all")}</SelectItem>
              <SelectItem value="active">{t("platformCompaniesUi.filter.active")}</SelectItem>
              <SelectItem value="suspended">{t("platformCompaniesUi.filter.suspended")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          {t("platformCompaniesUi.search")}
        </Button>
      </form>

      <RenewalWarnings />

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <CompaniesTable rows={rows} loading={loading} error={error} />
      </div>

      <nav
        aria-label={t("platformCompaniesUi.title")}
        className="flex items-center justify-between gap-3 text-sm"
      >
        <Button
          type="button"
          variant="outline"
          disabled={loading || page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          {t("common.previous")}
        </Button>
        <span className="tabular-nums text-muted-foreground">
          {t("platformCompaniesUi.page")} {page} {t("platformCompaniesUi.of")} {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={loading || page >= pageCount}
          onClick={() => setPage((current) => current + 1)}
        >
          {t("common.next")}
        </Button>
      </nav>

      <CompanyCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCompanyCreated={() => void load()}
      />
    </section>
  );
}
