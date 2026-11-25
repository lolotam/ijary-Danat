import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { StoreLogoCard } from "@/components/admin/StoreLogoCard";
import { ContractSwitcher } from "@/components/portal/ContractSwitcher";
import { PortalKpiCards, kpiGridClass } from "@/components/portal/PortalKpiCards";
import { TenantMessageForm } from "@/components/portal/TenantMessageForm";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { brandForSelectedContract, useBrandsForTenantContracts } from "@/hooks/useLinkedBrand";
import {
  usePortalIdentity,
  usePortalInsurancePaid,
  usePortalInvoiceSummary,
  usePortalLease,
} from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";
import { joinLocalized } from "@/lib/localeList";
import { formatKwd } from "@/lib/money";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import { unitDisplayName } from "@/lib/unitDisplayName";

export const Route = createFileRoute("/portal/")({ component: PortalDashboard });

/** البطاقات التي تقرأ ملخص الفواتير؛ إخفاؤها كلها يلغي قراءته. */
const SUMMARY_CARD_IDS = [
  "portal.nextDue",
  "portal.overdueInvoices",
  "portal.totalOverdue",
] as const;

/**
 * يظهر نموذج مراسلة الإدارة فقط بعد نجاح قراءة العلم، وإلا يبقى مخفياً.
 *
 * Fail-closed: a pending or rejected flag read must not flash the form, or an
 * admin who hid compose would still see it whenever the cards query blipped.
 */
export function PortalMessageComposeGate({ tenantId }: { tenantId: string }) {
  const flags = useCardVisibility();
  if (!flags.isReady || !flags.isCardVisible("portal.messageCompose")) return null;
  return <TenantMessageForm tenantId={tenantId} />;
}

/**
 * لوحة تحكم بوابة المستأجر: ملخص الإيجار والفواتير ورسائل الإدارة.
 */
function PortalDashboard() {
  const { locale, t } = useI18n();
  const identity = usePortalIdentity();
  const tenant = identity.data?.tenant ?? null;
  const { contractId } = usePortalContractSelection(tenant?.id ?? null);
  const lease = usePortalLease(tenant?.id ?? null, contractId);
  // A KPI read gates the page (skeleton / error) only once the flags have
  // loaded and say its card is shown. A hidden card, a pending flag read and a
  // failed flag read all leave the page up; PortalKpiCards shows its own
  // skeleton or nothing in those states. The page deliberately does NOT switch
  // on the flag read's state itself: a failed query refetches whenever a new
  // observer mounts, so toggling the page (and the cards' observers) on it
  // looped forever. Codex review rounds 1–2 on PR #266.
  const flags = useCardVisibility();
  const needsInsurance = flags.isReady && flags.isCardVisible("portal.insurance");
  const needsSummary =
    flags.isReady && SUMMARY_CARD_IDS.some((cardId) => flags.isCardVisible(cardId));
  const summary = usePortalInvoiceSummary(tenant?.id ?? null, contractId);
  const insurancePaid = usePortalInsurancePaid(tenant?.id ?? null, contractId);
  const brands = useBrandsForTenantContracts(tenant?.id ?? null);
  const linkedBrand = brandForSelectedContract(brands.data, contractId);
  // The insurance query is gated with the other two rather than left to render
  // `?? 0`: an unresolved or failed financial read shown as 0.000 KWD does not
  // read as a missing number, it reads as a statement that the office holds
  // none of this tenant's money. A skeleton says "not yet"; a zero lies.
  // Review round 1 on PR #212.
  if (
    !tenant ||
    lease.isLoading ||
    (needsSummary && summary.isLoading) ||
    (needsInsurance && insurancePaid.isLoading)
  ) {
    return (
      <div className={kpiGridClass(4)} role="status" aria-label={t("common.loading")}>
        {[0, 1, 2, 3].map((placeholder) => (
          <div
            key={placeholder}
            className="h-28 animate-pulse rounded-[18px] bg-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }
  // Explicit `needs…` checks: React Query keeps an earlier error on a query
  // after it is disabled, so a card hidden after its read failed would still
  // trip this gate.
  if (
    lease.isError ||
    (needsSummary && summary.isError) ||
    (needsInsurance && insurancePaid.isError)
  ) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
      >
        {t("common.error")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-lg border border-ink-accent/20 bg-ink p-6 text-ink-foreground shadow-[var(--shadow-raised)] sm:p-9">
        <div className="absolute inset-y-0 end-0 w-1/2 bg-[radial-gradient(circle_at_center,rgba(45,181,167,0.18),transparent_70%)]" />
        <div className="relative min-w-0">
          <p className="text-sm font-medium text-[#cbbf9e]">{t("portal.dashboard.welcome")}</p>
          <h1 className="mt-2 break-words text-3xl font-bold tracking-[-0.035em] text-white sm:text-5xl">
            {tenantDisplayName(tenant, locale)}
          </h1>
          <div className="mt-6 max-w-full">
            <ContractSwitcher
              tenantId={tenant.id}
              className="[&_button]:border-ink-accent/50 [&_button]:bg-white/10 [&_button]:text-white [&_button]:backdrop-blur"
            />
          </div>
          {lease.data?.contract ? (
            <div className="mt-8 grid gap-5 border-t border-ink-accent/20 pt-6 text-sm text-ink-foreground md:grid-cols-3">
              <div className="min-w-0">
                <p className="text-[#cbbf9e]">{t("portal.lease.unit")}</p>
                <p className="mt-1 break-words font-semibold">
                  {joinLocalized(
                    lease.data.units.map((unit) => unitDisplayName(unit, locale)),
                    locale,
                  ) || "—"}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-[#cbbf9e]">{t("portal.lease.contractPeriod")}</p>
                <p className="mt-1 font-semibold tabular-nums">
                  <FormattedDate value={lease.data.contract.start_date} empty="" /> —{" "}
                  <FormattedDate value={lease.data.contract.end_date} empty="" />
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-[#cbbf9e]">{t("portal.lease.monthlyAmount")}</p>
                <p className="mt-1 font-semibold tabular-nums">
                  {formatKwd(lease.data.contract.monthly_amount, locale)}
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-5 text-sm text-[#cbbf9e]">{t("portal.lease.noActive")}</p>
          )}
          <Button
            asChild
            size="lg"
            className="mt-8 min-h-11 bg-ink-accent text-ink-accent-foreground hover:bg-ink-highlight"
          >
            {/* Carry `?tenant=` and `?contract=` through: dropping tenant makes the
              portal layout treat a previewing admin as plain staff and bounce
              them to /admin; dropping contract loses the filter on My Invoices. */}
            <Link
              to="/portal/invoices"
              search={(prev: Record<string, unknown>) => ({
                ...prev,
                ...(contractId ? { contract: contractId } : {}),
              })}
            >
              <CreditCard className="size-4" />
              {t("portal.dashboard.payNow")}
            </Link>
          </Button>
        </div>
      </section>

      {/* Vibrant KPI cards — same component/language as the admin dashboard.
          Each card is gated by its own visibility flag inside the component. */}
      <PortalKpiCards
        insurancePaid={insurancePaid.data}
        nextDue={summary.data?.nextDue}
        overdueCount={summary.data?.overdueCount}
        overdueTotal={summary.data?.overdueTotal}
      />

      <StoreLogoCard brand={linkedBrand} tenantName={tenantDisplayName(tenant, locale)} />

      <PortalMessageComposeGate tenantId={tenant.id} />
    </div>
  );
}
