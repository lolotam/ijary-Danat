import { useEffect, useMemo, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ContractBuilderForm } from "@/components/admin/contracts/ContractBuilderForm";
import { ContractPreview } from "@/components/admin/contracts/ContractPreview";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { renderContractPdf } from "@/fns/renderContractPdf";
import { useCompany } from "@/hooks/useCompany";
import { useContract } from "@/hooks/useContracts";
import { useContractUnits } from "@/hooks/useContractRelations";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useUnitsForProperties } from "@/hooks/useUnits";
import { useTenant } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { contractPdfFilename } from "@/lib/contractBuilder/filename";
import { contractIssuerFromCompany } from "@/lib/contractBuilder/issuer";
import {
  localizedTradeName,
  prefillFromContract,
  type PrefillNotice,
} from "@/lib/contractBuilder/prefill";
import {
  contractBuilderDefaults,
  contractBuilderSchema,
  type ContractBuilderValues,
} from "@/lib/contractBuilder/schema";
import { PERMISSIONS } from "@/lib/permissions";

/** يهمل المعرّف غير الصالح بدلاً من إرسال استعلام قاعدة بيانات معطوب. */
export function validateBuilderSearch(search: Record<string, unknown>): { contract?: string } {
  const parsed = z.string().uuid().safeParse(search.contract);
  return parsed.success ? { contract: parsed.data } : {};
}

export const Route = createFileRoute("/admin/contracts_/builder")({
  beforeLoad: () => guardModuleRoute("contracts"),
  validateSearch: validateBuilderSearch,
  component: ContractBuilderPage,
});

/** يفصل بوابة الصلاحيات حتى لا تُجلب بيانات التعبئة للمستخدم غير المصرح له. */
function ContractBuilderPage() {
  const permissions = usePermissions();
  const { t } = useI18n();
  const { contract } = Route.useSearch();
  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.CONTRACTS_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  return <ContractBuilderEditor key={contract ?? "blank"} contractId={contract ?? null} />;
}

/** يعيد التعبئة مرة واحدة لكل عقد، ويترك إعادة الجلب الخلفية بعيدة عن تعديلات المستخدم. */
export function ContractBuilderEditor({ contractId }: { contractId: string | null }) {
  const { t, locale } = useI18n();
  const form = useForm<ContractBuilderValues>({
    resolver: zodResolver(contractBuilderSchema),
    defaultValues: contractBuilderDefaults,
    mode: "onBlur",
  });
  const contract = useContract(contractId);
  const tenant = useTenant(contract.data?.id === contractId ? contract.data.tenant_id : null);
  const units = useContractUnits(contractId);
  const resetId = useRef<string | null>(null);
  const prefilledTradeName = useRef<string>("");
  const [notices, setNotices] = useState<PrefillNotice[]>([]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (
      !contractId ||
      resetId.current === contractId ||
      !contract.isSuccess ||
      !tenant.isSuccess ||
      !units.isSuccess
    )
      return;
    if (contract.data.id !== contractId || tenant.data.id !== contract.data.tenant_id) return;
    const prefill = prefillFromContract(
      { contract: contract.data, tenant: tenant.data, units: units.data },
      form.getValues("language"),
    );
    form.reset({ ...contractBuilderDefaults, ...prefill.values });
    setNotices(prefill.notices);
    prefilledTradeName.current = prefill.values.trade_name ?? "";
    resetId.current = contractId;
  }, [
    contractId,
    contract.isSuccess,
    contract.data,
    tenant.isSuccess,
    tenant.data,
    units.isSuccess,
    units.data,
    form,
  ]);

  const language = form.watch("language");
  /**
   * يُتبع الاسم التجاري لغة الوثيقة ما دام كما عبأه التعبئة المسبقة.
   *
   * The prefill runs once, under whatever language was selected then, so a
   * later switch to English would otherwise keep the Arabic trade name and
   * the operator could never reach `commercial_name_en` through the UI. Only a
   * field still holding exactly what the prefill wrote is replaced; anything
   * the operator typed is theirs.
   */
  useEffect(() => {
    if (!tenant.isSuccess || resetId.current !== contractId) return;
    if (form.getValues("trade_name") !== prefilledTradeName.current) return;
    const localized = localizedTradeName(tenant.data, language);
    if (localized === prefilledTradeName.current) return;
    form.setValue("trade_name", localized, { shouldDirty: false });
    prefilledTradeName.current = localized;
  }, [language, contractId, tenant.isSuccess, tenant.data, form]);

  /** يحرر رابط الملف المؤقت ويعيد تفعيل التنزيل حتى عند فشل الشبكة أو المتصفح. */
  async function downloadPdf(values: ContractBuilderValues) {
    setPending(true);
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const response = await renderContractPdf({ data: { values, locale: values.language } });
      if (!response.ok) throw new Error(String(response.status));
      url = URL.createObjectURL(await response.blob());
      anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = contractPdfFilename(values);
      document.body.appendChild(anchor);
      anchor.click();
    } catch {
      toast.error(t("contractBuilder.downloadFailed"));
    } finally {
      anchor?.remove();
      if (url) URL.revokeObjectURL(url);
      setPending(false);
    }
  }
  const values = form.watch();
  // 500 is far above the ten plots the company owns; the picker must list all
  // of them, and the default page of 10 would be exactly full today.
  const properties = useProperties({ pageSize: 500 });
  const plotUnits = useUnitsForProperties(values.plots.map((plot) => plot.id));
  const company = useCompany();
  const issuer = useMemo(() => contractIssuerFromCompany(company.data ?? null), [company.data]);
  return (
    <div className="space-y-4">
      <Toaster richColors position="top-center" />
      <h1 className="text-2xl font-bold">{t("contractBuilder.title")}</h1>
      {(contract.isError ||
        tenant.isError ||
        units.isError ||
        properties.isError ||
        plotUnits.isError) && (
        <p role="alert" className="text-destructive">
          {t("common.error")}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <form className="space-y-4" onSubmit={form.handleSubmit(downloadPdf)} noValidate>
          <ContractBuilderForm
            form={form}
            t={t}
            notices={notices}
            locale={locale}
            inventory={{
              properties: properties.data?.items ?? [],
              units: plotUnits.data ?? [],
              unitsLoading: plotUnits.isLoading,
            }}
          />
          <Button type="submit" disabled={pending}>
            {t(pending ? "common.loading" : "contractBuilder.download")}
          </Button>
        </form>
        <section className="space-y-2">
          <h2>{t("contractBuilder.preview")}</h2>
          <ContractPreview values={values} locale={values.language} issuer={issuer} />
        </section>
      </div>
    </div>
  );
}
