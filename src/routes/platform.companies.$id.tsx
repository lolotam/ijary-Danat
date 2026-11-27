import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CompanyStatusControl } from "@/components/platform/CompanyStatusControl";
import { CompanyUsersPanel } from "@/components/platform/CompanyUsersPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { CompanyStatus } from "@/integrations/supabase/database.types";
import type { PlatformCompanyDetail } from "@/platform/companies";
import {
  fetchPlatformCompany,
  platformErrorMessage,
  updatePlatformCompany,
} from "@/platform/platformFns";

/** حقول نموذج تعديل الشركة. */
interface CompanyForm {
  nameAr: string;
  nameEn: string;
  email: string;
  phone: string;
  whatsapp: string;
  addressAr: string;
  addressEn: string;
}

export const Route = createFileRoute("/platform/companies/$id")({
  ssr: false,
  component: PlatformCompanyDetailPage,
});

/**
 * يحوّل حقلاً فارغاً إلى `null`، لأن الحقل الفارغ يمسح القيمة لا يتركها.
 */
function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * صفحة شركة واحدة: بياناتها القابلة للتعديل، وحالتها، وحساباتها.
 *
 * The short name is shown but not edited: the database freezes it after the
 * insert, because the company's address is built on it.
 */
export function PlatformCompanyDetailPage() {
  const { t } = useI18n();
  const { id: companyId } = Route.useParams();
  const [company, setCompany] = useState<PlatformCompanyDetail | null>(null);
  const [form, setForm] = useState<CompanyForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  /** يقرأ الشركة ويملأ نموذج التعديل بحالتها. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await fetchPlatformCompany({ companyId });
      setCompany(loaded);
      setForm({
        nameAr: loaded.nameAr,
        nameEn: loaded.nameEn,
        email: loaded.email ?? "",
        phone: loaded.phone ?? "",
        whatsapp: loaded.whatsapp ?? "",
        addressAr: loaded.addressAr ?? "",
        addressEn: loaded.addressEn ?? "",
      });
      setError(null);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** يضع قيمة حقل واحد من نموذج التعديل. */
  function setField(field: keyof CompanyForm, value: string) {
    setForm((current) => (current ? { ...current, [field]: value } : current));
    setSaved(false);
  }

  /**
   * يحفظ بيانات الشركة القابلة للتعديل.
   */
  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;

    setSaveError(null);
    if (!form.nameAr.trim() || !form.nameEn.trim()) {
      setSaveError(t("platformCompaniesUi.detail.error.nameRequired"));
      return;
    }

    setBusy(true);
    try {
      const updated = await updatePlatformCompany({
        companyId,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        email: emptyToNull(form.email),
        phone: emptyToNull(form.phone),
        whatsapp: emptyToNull(form.whatsapp),
        addressAr: emptyToNull(form.addressAr),
        addressEn: emptyToNull(form.addressEn),
      });
      setCompany((current) => (current ? { ...current, ...updated } : current));
      setSaved(true);
    } catch (cause) {
      setSaveError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  /** يحدّث حالة الشركة بعد قرار الإيقاف أو إعادة التفعيل. */
  function handleStatusChanged(next: CompanyStatus) {
    setCompany((current) => (current ? { ...current, status: next } : current));
    void load();
  }

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("common.loading")}
      </p>
    );
  }

  if (error || !company || !form) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error ?? t("platformCompaniesUi.error.load")}
      </p>
    );
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link
          to="/platform/companies"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowRight aria-hidden className="size-4 rotate-180" />
          {t("platformCompaniesUi.title")}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{company.nameAr}</h1>
          <Badge variant={company.status === "active" ? "success" : "warning"}>
            {company.status === "active"
              ? t("platformCompaniesUi.status.active")
              : t("platformCompaniesUi.status.suspended")}
          </Badge>
        </div>
        <p dir="ltr" className="font-mono text-sm text-muted-foreground">
          {company.slug}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("platformCompaniesUi.detail.slugReadOnly")}
        </p>
      </header>

      {company.status === "suspended" && company.suspendedReason ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <p className="font-medium">{t("platformCompaniesUi.detail.suspendedReason")}</p>
          <p className="mt-1">{company.suspendedReason}</p>
          {company.suspendedAt ? (
            <p dir="ltr" className="mt-1 text-xs text-muted-foreground">
              {t("platformCompaniesUi.detail.suspendedAt")}: {company.suspendedAt}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <form className="grid gap-4" onSubmit={handleSave}>
          <h2 className="text-lg font-semibold">{t("platformCompaniesUi.detail.title")}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-name-ar" required>
                {t("platformCompaniesUi.create.nameAr")}
              </Label>
              <Input
                id="platform-company-name-ar"
                value={form.nameAr}
                onChange={(event) => setField("nameAr", event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-name-en" required>
                {t("platformCompaniesUi.create.nameEn")}
              </Label>
              <Input
                id="platform-company-name-en"
                dir="ltr"
                value={form.nameEn}
                onChange={(event) => setField("nameEn", event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-email">
                {t("platformCompaniesUi.create.adminEmail")}
              </Label>
              <Input
                id="platform-company-email"
                type="email"
                value={form.email}
                onChange={(event) => setField("email", event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-phone">
                {t("platformCompaniesUi.create.adminPhone")}
              </Label>
              <Input
                id="platform-company-phone"
                type="tel"
                value={form.phone}
                onChange={(event) => setField("phone", event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-whatsapp">
                {t("platformCompaniesUi.create.adminPhone")}
              </Label>
              <Input
                id="platform-company-whatsapp"
                type="tel"
                value={form.whatsapp}
                onChange={(event) => setField("whatsapp", event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-address-ar">{t("common.addressAr")}</Label>
              <Input
                id="platform-company-address-ar"
                value={form.addressAr}
                onChange={(event) => setField("addressAr", event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="platform-company-address-en">{t("common.addressEn")}</Label>
              <Input
                id="platform-company-address-en"
                dir="ltr"
                value={form.addressEn}
                onChange={(event) => setField("addressEn", event.target.value)}
              />
            </div>
          </div>

          {saveError ? (
            <p className="text-sm text-destructive" role="alert">
              {saveError}
            </p>
          ) : null}
          {saved ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("common.saved")}
            </p>
          ) : null}

          <div>
            <Button type="submit" disabled={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>

        <aside className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-lg font-semibold">{t("platformCompaniesUi.detail.title")}</h2>
          <CompanyStatusControl
            companyId={companyId}
            status={company.status}
            onStatusChanged={handleStatusChanged}
          />
        </aside>
      </div>

      <CompanyUsersPanel companyId={companyId} />
    </section>
  );
}
