import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { SettingsForm } from "@/components/admin/settings/CompanySettingsForm";
import { EraseAllDataSection } from "@/components/admin/settings/EraseAllDataSection";
import {
  companyFormValues,
  companyUpdate,
  emptyValues,
  makeSettingsSchema,
  type SettingsFormValues,
} from "@/components/admin/settings/companySettingsSchema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { useCompany, useUpdateCompany } from "@/hooks/useCompany";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import type { Locale } from "@/i18n/dictionary";
import { buildCompanyInfoDocument } from "@/lib/companyInfoDocument";
import { PERMISSIONS } from "@/lib/permissions";
import { downloadHtmlAsPdf } from "@/lib/printDocument";

export const Route = createFileRoute("/admin/settings/")({
  component: CompanySettingsPage,
});

function CompanySettingsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const canUpdate = permissions.can(PERMISSIONS.COMPANY_UPDATE);
  const companyQuery = useCompany(!permissions.isLoading && canUpdate);
  const updateCompany = useUpdateCompany();
  const [exportingPdf, setExportingPdf] = useState(false);

  const schema = useMemo(
    () =>
      makeSettingsSchema({
        required: t("settings.required"),
        invalidEmail: t("settings.invalidEmail"),
        invalidUrl: t("settings.invalidUrl"),
      }),
    [t],
  );

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: emptyValues,
  });

  useEffect(() => {
    const company = companyQuery.data;
    if (!company) return;

    form.reset(companyFormValues(company));
  }, [companyQuery.data, form]);

  if (permissions.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (permissions.error) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!canUpdate) return <p className="text-sm text-destructive">{t("common.notAuthorized")}</p>;
  if (companyQuery.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (companyQuery.error) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!companyQuery.data)
    return <p className="text-sm text-muted-foreground">{t("settings.noCompany")}</p>;

  const company = companyQuery.data;

  async function exportCompanyInfoPdf() {
    if (!company) return;
    setExportingPdf(true);
    try {
      const doc = buildCompanyInfoDocument(company, locale as Locale, {
        docTitle: t("settings.companyInfoTitle"),
        contactTitle: t("settings.contactInfo"),
        bankTitle: t("settings.bankDetails"),
        issuedOn: t("settings.issuedOn"),
        address: t("settings.addressAr"),
        email: t("settings.email"),
        whatsapp: t("settings.whatsapp"),
        phone: t("settings.phone"),
        facebook: t("settings.facebookUrl"),
        instagram: t("settings.instagramUrl"),
        bankName: t("settings.bankName"),
        iban: t("settings.iban"),
        website: t("settings.mapUrl"),
      });
      const ok = await downloadHtmlAsPdf(doc.html, doc.filename, {
        title: doc.title,
        dir: doc.dir,
        extraCss: doc.extraCss,
      });
      if (ok) toast.success(t("common.pdfReady"));
      else toast.error(t("common.popupBlocked"));
    } catch {
      toast.error(t("common.pdfFailed"));
    } finally {
      setExportingPdf(false);
    }
  }

  async function submitSettings(values: SettingsFormValues) {
    try {
      await updateCompany.mutateAsync({ id: company.id, updates: companyUpdate(values) });
      toast.success(t("settings.saved"));
    } catch (error) {
      toast.error(t("settings.saveError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("settings.subtitle")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={exportingPdf}
          onClick={exportCompanyInfoPdf}
          className="shrink-0"
        >
          <Download className="size-4" />
          {t("settings.exportCompanyInfo")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.title")}</CardTitle>
          <CardDescription>{t("settings.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsForm
            form={form}
            isPending={updateCompany.isPending}
            submitSettings={submitSettings}
          />
        </CardContent>
      </Card>

      <EraseAllDataSection isAdmin={permissions.isAdmin} />
    </div>
  );
}
