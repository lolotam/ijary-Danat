import { useState } from "react";
import { Download, Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import {
  ChargeStatusBadge,
  ElectricityField,
  ElectricityFilter,
  OwnershipBadge,
} from "@/components/admin/electricity/ElectricityUi";
import { GenerateChargesDialog } from "@/components/admin/electricity/GenerateChargesDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useElectricityCharges,
  useUpdateElectricityChargeStatus,
  type ElectricityCharge,
} from "@/hooks/useElectricityCharges";
import { usePermissions } from "@/hooks/usePermissions";
import { useUnits } from "@/hooks/useUnits";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type {
  ElectricityChargeStatus,
  ElectricityMeterOwnership,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { downloadCsv } from "@/lib/csv";
import { formatElectricityNumber } from "@/lib/electricity";
import { formatKwd } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";

const chargeStatuses = ["draft", "issued", "paid", "cancelled"] as const;
const ownershipTypes = ["company_owned", "tenant_owned"] as const;
const currentDate = new Date();

type PendingTransition = {
  charge: ElectricityCharge;
  status: ElectricityChargeStatus;
};

/**
 * تبويب رسوم الكهرباء: الفلاتر، الجدول، التصدير، وتغيير حالة الرسم.
 *
 * Generation lives in `GenerateChargesDialog`, which owns its own period so
 * the list filter's period can never be what gets generated (audit M30).
 */
export function ChargesTab() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const [periodYear, setPeriodYear] = useState(String(currentDate.getFullYear()));
  const [periodMonth, setPeriodMonth] = useState<string>("all");
  const [unitId, setUnitId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [ownership, setOwnership] = useState<string>("all");
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null);
  const units = useUnits({ page: 1, pageSize: 500 });
  const filters = {
    ownership: ownership === "all" ? undefined : (ownership as ElectricityMeterOwnership),
    periodMonth: periodMonth === "all" ? undefined : Number(periodMonth),
    periodYear: periodYear ? Number(periodYear) : undefined,
    search: debouncedSearch,
    status: status === "all" ? undefined : (status as ElectricityChargeStatus),
    unitId: unitId === "all" ? undefined : unitId,
  };
  const charges = useElectricityCharges({ ...filters, page, pageSize: 10 });
  const exportCharges = useElectricityCharges(
    { ...filters, page: 1, pageSize: 5000 },
    permissions.can(PERMISSIONS.ELECTRICITY_EXPORT),
  );
  const updateStatus = useUpdateElectricityChargeStatus();

  const resetPage = () => setPage(1);

  const exportCsv = async () => {
    const rows = (exportCharges.data?.items ?? []).map((charge) => ({
      code: charge.code,
      unit: charge.unit?.code ?? "",
      tenant: charge.tenant?.name ?? "",
      meter: charge.meter?.meter_number ?? "",
      ownership: charge.meter ? t(`electricity.ownership.${charge.meter.ownership}`) : "",
      period: `${charge.period_month}/${charge.period_year}`,
      consumption_kwh: charge.consumption_kwh,
      amount: charge.amount,
      currency: charge.currency,
      status: t(`electricity.status.${charge.status}`),
    }));
    if (!rows.length) return;
    try {
      await logAuditForCurrentSession({
        action: "electricity_charge.export",
        entityType: "electricity_charge_export",
        after: { filters, exported: rows.length },
      });
      downloadCsv("electricity-charges.csv", rows);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={
            !permissions.can(PERMISSIONS.ELECTRICITY_EXPORT) || !exportCharges.data?.items.length
          }
          onClick={exportCsv}
        >
          <Download className="size-4" />
          {t("electricity.charges.export")}
        </Button>
        <Button
          disabled={!permissions.can(PERMISSIONS.ELECTRICITY_CREATE)}
          onClick={() => setGenerateDialogOpen(true)}
        >
          <Plus className="size-4" />
          {t("electricity.charges.generate")}
        </Button>
      </div>

      <Card>
        <CardHeader className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Input
            value={search}
            placeholder={t("common.search")}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
          />
          <ElectricityField label={t("electricity.periodYear")}>
            <Input
              type="number"
              min="2000"
              max="2200"
              value={periodYear}
              onChange={(event) => {
                setPeriodYear(event.target.value);
                resetPage();
              }}
            />
          </ElectricityField>
          <ElectricityFilter
            label={t("electricity.periodMonth")}
            value={periodMonth}
            options={Array.from({ length: 12 }, (_, index) => ({
              value: String(index + 1),
              label: String(index + 1),
            }))}
            onChange={(selectedMonth) => {
              setPeriodMonth(selectedMonth);
              resetPage();
            }}
          />
          <ElectricityFilter
            label={t("electricity.unit")}
            value={unitId}
            options={(units.data?.items ?? []).map((unit) => ({
              value: unit.id,
              label: `${unit.code} — ${unit.name}`,
            }))}
            onChange={(selectedUnitId) => {
              setUnitId(selectedUnitId);
              resetPage();
            }}
          />
          <ElectricityFilter
            label={t("common.status")}
            value={status}
            options={chargeStatuses.map((chargeStatus) => ({
              value: chargeStatus,
              label: t(`electricity.status.${chargeStatus}`),
            }))}
            onChange={(selectedStatus) => {
              setStatus(selectedStatus);
              resetPage();
            }}
          />
          <ElectricityFilter
            label={t("electricity.ownership")}
            value={ownership}
            options={ownershipTypes.map((ownershipType) => ({
              value: ownershipType,
              label: t(`electricity.ownership.${ownershipType}`),
            }))}
            onChange={(selectedOwnership) => {
              setOwnership(selectedOwnership);
              resetPage();
            }}
          />
        </CardHeader>
        <CardContent className="p-0">
          <TableState
            loading={charges.isLoading}
            error={charges.isError}
            empty={!charges.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{t("common.code")}</TableHead>
                    <TableHead>{t("electricity.unit")}</TableHead>
                    <TableHead>{t("electricity.tenant")}</TableHead>
                    <TableHead>{t("electricity.ownership")}</TableHead>
                    <TableHead>{t("electricity.period")}</TableHead>
                    <TableHead>{t("electricity.consumption")}</TableHead>
                    <TableHead>{t("common.amount")}</TableHead>
                    <TableHead>{t("common.status")}</TableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(charges.data?.items ?? []).map((charge, index) => (
                    <TableRow key={charge.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell className="font-mono">{charge.code}</TableCell>
                      <TableCell>
                        {charge.unit ? `${charge.unit.code} — ${charge.unit.name}` : "—"}
                      </TableCell>
                      <TableCell>
                        {charge.tenant ? `${charge.tenant.code} — ${charge.tenant.name}` : "—"}
                      </TableCell>
                      <TableCell>
                        {charge.meter ? <OwnershipBadge ownership={charge.meter.ownership} /> : "—"}
                      </TableCell>
                      <TableCell>
                        {charge.period_month}/{charge.period_year}
                      </TableCell>
                      <TableCell>
                        {formatElectricityNumber(charge.consumption_kwh)} {t("electricity.kwh")}
                      </TableCell>
                      <TableCell>{formatKwd(charge.amount, locale, charge.currency)}</TableCell>
                      <TableCell>
                        <ChargeStatusBadge status={charge.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {charge.status === "draft" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)}
                              onClick={() => setPendingTransition({ charge, status: "issued" })}
                            >
                              {t("electricity.action.issue")}
                            </Button>
                          )}
                          {charge.status === "issued" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)}
                              onClick={() => setPendingTransition({ charge, status: "paid" })}
                            >
                              {t("electricity.action.markPaid")}
                            </Button>
                          )}
                          {(charge.status === "draft" || charge.status === "issued") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              disabled={!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)}
                              onClick={() => setPendingTransition({ charge, status: "cancelled" })}
                            >
                              {t("electricity.action.cancel")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableState>
          <Pager page={page} pageSize={10} count={charges.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <GenerateChargesDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
        units={units.data?.items ?? []}
      />

      <DeleteConfirmation
        open={Boolean(pendingTransition)}
        pending={updateStatus.isPending}
        title={t("electricity.charges.statusConfirmTitle")}
        description={
          pendingTransition
            ? `${t("electricity.charges.statusConfirm")} ${t(`electricity.status.${pendingTransition.status}`)}`
            : ""
        }
        close={() => setPendingTransition(null)}
        confirm={async () => {
          if (!pendingTransition) return;
          try {
            await updateStatus.mutateAsync(pendingTransition);
            setPendingTransition(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </div>
  );
}
