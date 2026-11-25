import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Download, Eye, Plus, Upload } from "lucide-react";
import { toast } from "sonner";

import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { EntityLink } from "@/components/admin/EntityLink";
import {
  DeleteConfirmation,
  ModuleHeader,
  SelectFilter,
  TableState,
} from "@/components/admin/Phase2Ui";
import { UnitsKpiCards } from "@/components/admin/ownedPageKpis";
import { SummaryCards } from "@/components/admin/SummaryCards";
import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { UnitFormDialog } from "@/components/admin/UnitFormDialog";
import { useActiveContractRent, useActiveContractRents } from "@/hooks/useActiveContractRent";

import { Badge } from "@/components/ui/badge";
import { unitStatusTone, unitTypeTone } from "@/lib/statusTone";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Toaster } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCatalogueLabel,
  useListDrivenOptions,
  useOptionListItemsByCode,
} from "@/hooks/useOptionLists";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useUnitsSummary } from "@/hooks/useUnitsSummary";
import { useDeleteUnit, useUnitExport, useUnits, type Unit } from "@/hooks/useUnits";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { ElectricityMeterOwnership, UnitStatus } from "@/integrations/supabase/database.types";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import { mapCatalogueOptions } from "@/lib/commercialActivityOptions";
import { exportRecordsToCsv } from "@/lib/csv";
import { formatAmount } from "@/lib/money";
import { unitStatusFilterValues } from "@/lib/unitForm";
import { unitCsvNames } from "@/lib/unitDisplayName";
import { PERMISSIONS } from "@/lib/permissions";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { showError } from "@/lib/toastError";

export const Route = createFileRoute("/admin/units/")({ component: UnitsPage });

function UnitsPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible } = useCardVisibility();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [propertyId, setPropertyId] = useState("all");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [meter, setMeter] = useState("all");
  const [dialog, setDialog] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Unit | null>(null);

  /** إيجار الوحدة قيد التعديل من عقدها النشط، إن وُجد. */
  const editedUnitRent =
    useActiveContractRent(editing?.id, permissions.can(PERMISSIONS.CONTRACTS_READ)).data ?? null;
  const [deleteTarget, setDeleteTarget] = useState<Unit | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const unitFilters = {
    search: debouncedSearch,
    propertyId: propertyId === "all" ? undefined : propertyId,
    status: status === "all" ? undefined : (status as UnitStatus),
    type: type === "all" ? undefined : type,
    electricityMeterOwnership: meter === "all" ? undefined : (meter as ElectricityMeterOwnership),
  };
  const units = useUnits(
    { page: 1, pageSize: 1000, ...unitFilters },
    permissions.can(PERMISSIONS.UNITS_READ),
  );
  const summary = useUnitsSummary(unitFilters, permissions.can(PERMISSIONS.UNITS_READ));
  const unitExport = useUnitExport(unitFilters, permissions.can(PERMISSIONS.UNITS_EXPORT));
  const properties = useProperties({ pageSize: 100 }, permissions.can(PERMISSIONS.PROPERTIES_READ));
  /**
   * إيجارات الوحدات الظاهرة من عقودها النشطة.
   *
   * The column used to read `units.default_rent`, a column nothing keeps in step
   * with the contracts — UNIT-00004 showed 600 while its contract billed 1350.
   * The contract is what invoices the tenant, so it is what the column shows.
   */
  const visibleUnitRents = useActiveContractRents(
    (units.data?.items ?? []).map((unit) => unit.id),
    permissions.can(PERMISSIONS.CONTRACTS_READ),
  );

  const {
    sort,
    toggle,
    sorted: sortedUnits,
  } = useTableSort(
    units.data?.items ?? [],
    (unit, key) => {
      if (key === "occupant") return unit.occupant?.name ?? null;
      // Sorted on the figure the column actually shows. Sorting on `default_rent`
      // while displaying the contract rent ordered the rows by a hidden value.
      if (key === "rent") return visibleUnitRents.data?.get(unit.id) ?? null;
      return (unit as unknown as Record<string, unknown>)[key];
    },
    undefined,
    [visibleUnitRents.data],
  );

  const remove = useDeleteUnit();
  // Free-text type (migration 103) — catalogue for filter, not enum allow-list.
  const unitTypeItems = useOptionListItemsByCode("unit_types");
  const unitTypeOptions = mapCatalogueOptions(unitTypeItems.data ?? [], locale);
  // The stored value needs the same catalogue the filter uses; the dictionary
  // only ever covered the seven seeds.
  const unitTypeLabel = useCatalogueLabel("unit_types", "unitType");
  const unitFloorLabel = useCatalogueLabel("unit_floors", "unitFloor");
  /**
   * `occupied` is filterable but not settable: migration 76 derives it from the
   * unit's active contract. Filter options include occupied so operators can
   * find currently occupied units; the form's editable set is narrower.
   */
  const unitStatusFilterOptions = useListDrivenOptions(
    "unit_statuses",
    unitStatusFilterValues,
    "unitStatus",
  );

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      toast.success(t("phase2.deleted"));
      setDeleteTarget(null);
    } catch (error) {
      showError(t("phase2.deleteError"), error);
    }
  }
  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.UNITS_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  const propertyName = new Map(
    (properties.data?.items ?? []).map((property) => [
      property.id,
      locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar),
    ]),
  );
  const propertyById = new Map(
    (properties.data?.items ?? []).map((property) => [property.id, property]),
  );

  function exportUnits() {
    exportRecordsToCsv(
      (unitExport.data?.items ?? []).map((unit) => {
        const property = propertyById.get(unit.property_id);
        return {
          code: unit.code,
          property_code: property?.code ?? "",
          connected_property_name_ar: property?.name_ar ?? "",
          connected_property_name_en: property?.name_en ?? "",
          name: unitCsvNames(unit).ar,
          name_en: unitCsvNames(unit).en,
          type: unit.type,
          area: unit.area ?? "",
          status: unit.status,
          electricity_meter_ownership: unit.electricity_meter_ownership,
          default_rent: unit.default_rent ?? "",
          description_ar: unit.description_ar ?? "",
          description_en: unit.description_en ?? "",
        };
      }),
      "units.csv",
      locale,
    );
  }
  const meters: ElectricityMeterOwnership[] = ["company_owned", "tenant_owned"];
  const listTruncated =
    (units.data?.count ?? 0) > (units.data?.items.length ?? 0)
      ? t("common.listTruncated")
          .replace("{shown}", String(units.data?.items.length ?? 0))
          .replace("{total}", String(units.data?.count ?? 0))
      : null;

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("units.title")}
        subtitle={t("units.subtitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => downloadImportTemplate("units", locale)}>
              <Download className="size-4" />
              {t("import.downloadTemplate")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.UNITS_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              variant="outline"
              disabled={!unitExport.data?.items.length}
              onClick={exportUnits}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.UNITS_CREATE)}
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="size-4" />
              {t("units.add")}
            </Button>
          </>
        }
      />
      <SummaryCards loading={summary.isLoading} error={summary.error}>
        <UnitsKpiCards summary={summary.data} isCardVisible={isCardVisible} />
      </SummaryCards>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder={t("units.search")}
        />
        <SelectFilter
          value={propertyId}
          onChange={setPropertyId}
          label={t("units.property")}
          options={sortPropertiesByCodeNatural(properties.data?.items ?? []).map((property) => ({
            value: property.id,
            label: locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar),
          }))}
        />
        <SelectFilter
          value={status}
          onChange={setStatus}
          label={t("common.status")}
          options={unitStatusFilterOptions}
        />
        <SelectFilter
          value={type}
          onChange={setType}
          label={t("common.type")}
          options={unitTypeOptions}
        />
        <SelectFilter
          value={meter}
          onChange={setMeter}
          label={t("units.meterOwnership")}
          options={meters.map((value) => ({ value, label: t(`meterOwnership.${value}`) }))}
        />
      </div>
      {permissions.can(PERMISSIONS.UNITS_DELETE) && (
        <BulkDeleteBar
          selected={selected}
          clear={() => setSelected([])}
          deleteOne={(id) => remove.mutateAsync(id).then(() => undefined)}
          entityLabel={t("units.title")}
        />
      )}
      {listTruncated && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          {listTruncated}
        </p>
      )}
      <div className="overflow-hidden rounded-xl border bg-card">
        <TableState
          loading={units.isLoading}
          error={Boolean(units.error)}
          empty={!units.data?.items.length}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={
                      (units.data?.items.length ?? 0) > 0 &&
                      selected.length === (units.data?.items.length ?? 0)
                    }
                    onCheckedChange={(v) =>
                      setSelected(v ? (units.data?.items ?? []).map((x) => x.id) : [])
                    }
                  />
                </TableHead>
                <TableHead>#</TableHead>
                <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                  {t("common.code")}
                </SortableHead>
                <SortableHead sortKey="paci_no" sort={sort} toggle={toggle}>
                  {t("units.paciNo")}
                </SortableHead>
                <SortableHead sortKey="name" sort={sort} toggle={toggle}>
                  {t("units.nameAr")}
                </SortableHead>
                <SortableHead sortKey="property_id" sort={sort} toggle={toggle}>
                  {t("units.property")}
                </SortableHead>
                <SortableHead sortKey="type" sort={sort} toggle={toggle}>
                  {t("common.type")}
                </SortableHead>
                <SortableHead sortKey="floor" sort={sort} toggle={toggle}>
                  {t("units.floor")}
                </SortableHead>
                <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                  {t("common.status")}
                </SortableHead>
                <SortableHead sortKey="rent" sort={sort} toggle={toggle}>
                  {t("units.rent")}
                </SortableHead>
                <SortableHead sortKey="occupant" sort={sort} toggle={toggle}>
                  {t("units.occupant")}
                </SortableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedUnits.map((unit, index) => {
                const propertyLabel = propertyName.get(unit.property_id);
                return (
                  <TableRow key={unit.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(unit.id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) =>
                            v ? [...prev, unit.id] : prev.filter((x) => x !== unit.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{unit.code}</TableCell>
                    <TableCell className="font-mono text-xs">{unit.paci_no ?? "—"}</TableCell>
                    <TableCell className="font-medium">
                      <EntityLink kind="unit" id={unit.id}>
                        {unit.name}
                      </EntityLink>
                    </TableCell>
                    <TableCell>
                      {propertyLabel ? (
                        <EntityLink kind="property" id={unit.property_id}>
                          {propertyLabel}
                        </EntityLink>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={unitTypeTone(unit.type)}>{unitTypeLabel(unit.type)}</Badge>
                    </TableCell>
                    <TableCell>{unit.floor ? unitFloorLabel(unit.floor) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={unitStatusTone(unit.status)}>
                        {t(`unitStatus.${unit.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {visibleUnitRents.isError ? (
                        // Distinguished from "no contract": both would otherwise
                        // render an em dash, and a failed lookup would read as
                        // every unit being vacant.
                        <span className="text-destructive text-xs">{t("common.error")}</span>
                      ) : visibleUnitRents.data?.has(unit.id) ? (
                        formatAmount(visibleUnitRents.data.get(unit.id)!, locale)
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {unit.occupant ? (
                        <EntityLink kind="tenant" id={unit.occupant.id}>
                          {unit.occupant.name}
                        </EntityLink>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <TableActionButton action="view" asChild>
                          <Link to="/admin/units/$id" params={{ id: unit.id }}>
                            <Eye className="size-4" />
                          </Link>
                        </TableActionButton>
                        <TableActionButton
                          action="edit"
                          disabled={!permissions.can(PERMISSIONS.UNITS_UPDATE)}
                          onClick={() => {
                            setEditing(unit);
                            setDialog(true);
                          }}
                        />
                        <TableActionButton
                          action="delete"
                          disabled={!permissions.can(PERMISSIONS.UNITS_DELETE)}
                          onClick={() => setDeleteTarget(unit)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableState>
      </div>
      <UnitFormDialog
        open={dialog}
        onOpenChange={setDialog}
        editing={editing}
        onSaved={setEditing}
        activeContractRent={editedUnitRent}
      />
      <CsvImportDialog entity="units" open={importOpen} onOpenChange={setImportOpen} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={remove.isPending}
        title={t("phase2.deleteTitle")}
        description={t("units.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDelete}
      />
    </div>
  );
}
