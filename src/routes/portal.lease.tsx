import { createFileRoute } from "@tanstack/react-router";
import { BadgePercent, Building2, CalendarRange, CircleDollarSign } from "lucide-react";
import type { ReactNode } from "react";

import { ContractSwitcher } from "@/components/portal/ContractSwitcher";
import { SectionCard } from "@/components/shared/SectionCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FormattedDate } from "@/components/ui/formatted-date";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { useCatalogueLabel } from "@/hooks/useOptionLists";
import { usePortalIdentity, usePortalLease } from "@/hooks/usePortalData";
import { useI18n } from "@/i18n/provider";
import { formatIsoDateForDisplay } from "@/lib/dateDisplay";
import { concessionValueText } from "@/lib/concessionColumns";
import { joinLocalized } from "@/lib/localeList";
import { formatKwd } from "@/lib/money";
import { propertyDisplayName } from "@/lib/propertyDisplayName";
import { unitDisplayName } from "@/lib/unitDisplayName";

export const Route = createFileRoute("/portal/lease")({ component: PortalLeasePage });

/**
 * يظهر قسم التنازلات في عقد المستأجر فقط بعد نجاح قراءة العلم.
 *
 * Fail-closed like the compose gate: a hidden concessions block must stay
 * hidden when the flag read is pending or rejected.
 */
export function PortalLeaseConcessionsGate({ children }: { children: ReactNode }) {
  const flags = useCardVisibility();
  if (!flags.isReady || !flags.isCardVisible("portal.leaseConcessions")) return null;
  return children;
}

function PortalLeasePage() {
  const { locale, dir, t } = useI18n();
  const identity = usePortalIdentity();
  const tenantId = identity.data?.tenant?.id ?? null;
  const { contractId } = usePortalContractSelection(tenantId);
  const lease = usePortalLease(tenantId, contractId);
  // Above the early returns below — this is a hook, and the loading branch must
  // not change how many run. Free-text unit type (migration 103).
  const unitTypeLabel = useCatalogueLabel("unit_types", "unitType");

  if (lease.isLoading)
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  if (lease.isError) return <p className="text-sm text-destructive">{t("common.error")}</p>;
  if (!lease.data?.contract) {
    return (
      <div className="space-y-6">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">{t("portal.lease.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("portal.lease.subtitle")}</p>
          </div>
          <ContractSwitcher tenantId={tenantId} />
        </div>
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            {t("portal.lease.noActive")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const { contract, units, properties, concessions } = lease.data;
  // Every unit and building on the contract. This page used to show the primary
  // (lowest line_order) unit only, so a tenant renting three units saw one of
  // them and no sign the others existed.
  const details = [
    {
      label: t("portal.lease.building"),
      value:
        joinLocalized(
          properties.map((property) => propertyDisplayName(property, locale)),
          locale,
        ) || "—",
      icon: Building2,
      tile: "from-emerald-500 to-emerald-700 shadow-emerald-500/30",
    },
    {
      label: t("portal.lease.unit"),
      value:
        joinLocalized(
          units.map((unit) => `${unitDisplayName(unit, locale)} (${unit.code})`),
          locale,
        ) || "—",
      icon: Building2,
      tile: "from-indigo-500 to-indigo-700 shadow-indigo-500/30",
    },
    {
      label: t("portal.lease.unitType"),
      value:
        joinLocalized([...new Set(units.map((unit) => unitTypeLabel(unit.type)))], locale) || "—",
      icon: Building2,
      tile: "from-purple-500 to-purple-700 shadow-purple-500/30",
    },
    {
      label: t("portal.lease.contractType"),
      value: t(`contractType.${contract.type}`),
      icon: CalendarRange,
      tile: "from-blue-500 to-blue-700 shadow-blue-500/30",
    },
    {
      label: t("portal.lease.startDate"),
      value: formatIsoDateForDisplay(contract.start_date, dir),
      icon: CalendarRange,
      tile: "from-sky-500 to-cyan-700 shadow-sky-500/30",
    },
    {
      label: t("portal.lease.endDate"),
      value: formatIsoDateForDisplay(contract.end_date, dir),
      icon: CalendarRange,
      tile: "from-cyan-500 to-teal-700 shadow-cyan-500/30",
    },
    {
      label: t("portal.lease.monthlyAmount"),
      value: formatKwd(contract.monthly_amount, locale),
      icon: CircleDollarSign,
      tile: "from-emerald-500 to-emerald-700 shadow-emerald-500/30",
    },
    {
      label: t("portal.lease.dueDay"),
      value: String(contract.due_day),
      icon: CalendarRange,
      tile: "from-amber-500 to-orange-600 shadow-amber-500/30",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t("portal.lease.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("portal.lease.subtitle")}</p>
        </div>
        <ContractSwitcher tenantId={tenantId} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {details.map((detail) => {
          const Icon = detail.icon;
          return (
            <Card
              key={detail.label}
              className="min-w-0 transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <CardContent className="flex gap-4 p-5">
                <div
                  className={`grid size-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white shadow-md ${detail.tile}`}
                >
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{detail.label}</p>
                  <p className="mt-1 break-words font-bold">{detail.value}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <PortalLeaseConcessionsGate>
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <BadgePercent className="size-5" />
              {t("portal.lease.concessions")}
            </span>
          }
          gradient="from-amber-500 to-orange-600"
          bodyClassName="p-5"
        >
          {concessions.length ? (
            <div className="space-y-3">
              {concessions.map((concession) => {
                const valueText = concessionValueText(
                  concession,
                  locale,
                  t("portal.lease.monthsUnit"),
                );
                return (
                  <div
                    key={concession.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{t(`concessionType.${concession.type}`)}</p>
                        {valueText ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                            {valueText}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <FormattedDate value={concession.start_date} empty="" /> —{" "}
                        <FormattedDate value={concession.end_date} empty="" />
                      </p>
                    </div>
                    <Badge variant="outline">{t(`concessionStatus.${concession.status}`)}</Badge>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("portal.lease.noConcessions")}</p>
          )}
        </SectionCard>
      </PortalLeaseConcessionsGate>
    </div>
  );
}
