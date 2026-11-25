import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute } from "@tanstack/react-router";
import { Download, Plus, Upload } from "lucide-react";
import { useForm, type Resolver } from "react-hook-form";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";

import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import {
  DeleteConfirmation,
  ModuleHeader,
  Pager,
  SelectFilter,
  TableState,
} from "@/components/admin/Phase2Ui";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { Badge } from "@/components/ui/badge";
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
import { useBuildings } from "@/hooks/useBuildings";
import { useCompany } from "@/hooks/useCompany";
import {
  useCreateMaintenanceRequest,
  useDeleteMaintenanceRequest,
  useMaintenanceExport,
  useMaintenanceRequests,
  useUpdateMaintenanceRequest,
  type MaintenanceRequest,
} from "@/hooks/useMaintenance";
import { useIsMobile } from "@/hooks/use-mobile";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useUnits } from "@/hooks/useUnits";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type {
  MaintenancePriority,
  MaintenanceStatus,
} from "@/integrations/supabase/database.types";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import { exportRecordsToCsv } from "@/lib/csv";
import { PERMISSIONS } from "@/lib/permissions";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";
import { showError } from "@/lib/toastError";
import { MaintenanceFormDialog } from "@/components/admin/maintenance/MaintenanceFormDialog";
import { MaintenanceViewDialog } from "@/components/admin/maintenance/MaintenanceViewDialog";
import {
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  maintenanceDefaults,
  maintenancePayload,
  maintenanceSchema,
  maintenanceToForm,
  type MaintenanceFormValues,
} from "@/lib/maintenanceForm";

export const Route = createFileRoute("/admin/maintenance/")({ component: MaintenancePage });

/**
 * شاشة طلبات الصيانة: الفلاتر، الجدول، الاستيراد والتصدير، والإضافة والتعديل والعرض.
 *
 * The dialogs live in `components/admin/maintenance/` and the form's schema
 * and mappings in `lib/maintenanceForm.ts` (audit M13/M32); the page keeps the
 * form, the row being edited and the save, because a save keeps the dialog
 * open.
 */
function MaintenancePage() {
  const { t, locale } = useI18n();
  const posthog = usePostHog();
  const permissions = usePermissions();
  const isMobile = useIsMobile();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [propertyId, setPropertyId] = useState("all");
  const [buildingId, setBuildingId] = useState("all");
  const [unitId, setUnitId] = useState("all");
  const [priority, setPriority] = useState("all");
  const [status, setStatus] = useState("all");
  const [dialog, setDialog] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<MaintenanceRequest | null>(null);
  /**
   * معرّف الطلب الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * The dialog no longer closes on save, so a second Save without this would
   * file a duplicate maintenance request.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<MaintenanceRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MaintenanceRequest | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const filters = {
    search: debouncedSearch,
    propertyId: propertyId === "all" ? undefined : propertyId,
    buildingId: buildingId === "all" ? undefined : buildingId,
    unitId: unitId === "all" ? undefined : unitId,
    priority: priority === "all" ? undefined : (priority as MaintenancePriority),
    status: status === "all" ? undefined : (status as MaintenanceStatus),
  };
  const requests = useMaintenanceRequests(
    { page, pageSize: 10, ...filters },
    permissions.can(PERMISSIONS.MAINTENANCE_READ),
  );
  const requestExport = useMaintenanceExport(
    filters,
    permissions.can(PERMISSIONS.MAINTENANCE_EXPORT),
  );
  const properties = useProperties({ pageSize: 100 }, permissions.can(PERMISSIONS.PROPERTIES_READ));
  const buildings = useBuildings({ pageSize: 100 }, permissions.can(PERMISSIONS.BUILDINGS_READ));
  const units = useUnits({ pageSize: 100 }, permissions.can(PERMISSIONS.UNITS_READ));
  const company = useCompany();
  const create = useCreateMaintenanceRequest();
  const update = useUpdateMaintenanceRequest();
  const remove = useDeleteMaintenanceRequest();
  const form = useForm<MaintenanceFormValues>({
    resolver: zodResolver(maintenanceSchema) as Resolver<MaintenanceFormValues>,
    defaultValues: maintenanceDefaults,
  });
  const selectedFormProperty = form.watch("property_id");
  const selectedFormBuilding = form.watch("building_id");
  const selectedFormUnit = form.watch("unit_id");
  const formBuildings = useMemo(
    () =>
      (buildings.data?.items ?? []).filter(
        (building) => building.property_id === selectedFormProperty,
      ),
    [buildings.data?.items, selectedFormProperty],
  );
  const formUnits = useMemo(
    () =>
      (units.data?.items ?? []).filter(
        (unit) =>
          unit.property_id === selectedFormProperty &&
          (selectedFormBuilding === "none" || unit.building_id === selectedFormBuilding),
      ),
    [units.data?.items, selectedFormProperty, selectedFormBuilding],
  );

  useEffect(() => {
    if (dialog) {
      // A reopened dialog is a fresh create until it saves again.
      setCreatedId(null);
      form.reset(editing ? maintenanceToForm(editing) : maintenanceDefaults);
    }
  }, [dialog, editing, form]);
  useEffect(() => {
    if (
      buildings.data &&
      selectedFormBuilding !== "none" &&
      !formBuildings.some((building) => building.id === selectedFormBuilding)
    ) {
      form.setValue("building_id", "none");
    }
  }, [buildings.data, form, formBuildings, selectedFormBuilding]);
  useEffect(() => {
    if (
      units.data &&
      selectedFormUnit !== "none" &&
      !formUnits.some((unit) => unit.id === selectedFormUnit)
    ) {
      form.setValue("unit_id", "none");
    }
  }, [units.data, form, formUnits, selectedFormUnit]);

  /** يحفظ طلب الصيانة: تعديل إن سبق إنشاؤه أو اختير، وإلا إضافة. */
  async function save(values: MaintenanceFormValues) {
    const payload = maintenancePayload(values);
    // Coalesced before the branch: after a create the form stays open with
    // `editing` still null, so the next Save must update the row just filed.
    const editingId = editing?.id ?? createdId;
    try {
      if (editingId) await update.mutateAsync({ id: editingId, updates: payload });
      else {
        if (!company.data?.id) throw new Error("Company configuration is missing.");
        const created = await create.mutateAsync({ ...payload, company_id: company.data.id });
        setCreatedId(created.id);
      }
      posthog.capture("maintenance_request_saved", {
        operation: editingId ? "updated" : "created",
        priority: values.priority,
      });
      form.reset(values);
      toast.success(t("phase2.saved"));
    } catch (error) {
      showError(t("phase2.saveError"), error);
    }
  }
  /** يحذف طلب الصيانة المؤكَّد. */
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
  if (!permissions.can(PERMISSIONS.MAINTENANCE_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  const propertyName = new Map(
    (properties.data?.items ?? []).map((property) => [property.id, property.name_ar]),
  );
  const buildingName = new Map(
    (buildings.data?.items ?? []).map((building) => [building.id, building.name_ar]),
  );
  const unitName = new Map((units.data?.items ?? []).map((unit) => [unit.id, unit.name]));
  const propertyCode = new Map(
    (properties.data?.items ?? []).map((property) => [property.id, property.code]),
  );
  const buildingCode = new Map(
    (buildings.data?.items ?? []).map((building) => [building.id, building.code]),
  );
  const unitCode = new Map((units.data?.items ?? []).map((unit) => [unit.id, unit.code]));
  const resetPage = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
  };

  function exportRequests() {
    exportRecordsToCsv(
      (requestExport.data?.items ?? []).map((request) => ({
        code: request.code,
        property_code: propertyCode.get(request.property_id) ?? "",
        building_code: buildingCode.get(request.building_id ?? "") ?? "",
        unit_code: unitCode.get(request.unit_id ?? "") ?? "",
        title: request.title,
        description: request.description ?? "",
        priority: request.priority,
        status: request.status,
      })),
      "maintenance.csv",
    );
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("maintenance.title")}
        subtitle={t("maintenance.subtitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => downloadImportTemplate("maintenance", locale)}>
              <Download className="size-4" />
              {t("import.downloadTemplate")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.MAINTENANCE_CREATE)}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              variant="outline"
              disabled={!requestExport.data?.items.length}
              onClick={exportRequests}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.MAINTENANCE_CREATE)}
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="size-4" />
              {t("maintenance.add")}
            </Button>
          </>
        }
      />
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={t("maintenance.search")}
        />
        <SelectFilter
          value={propertyId}
          onChange={resetPage(setPropertyId)}
          label={t("units.property")}
          options={sortPropertiesByCodeNatural(properties.data?.items ?? []).map((property) => ({
            value: property.id,
            label: property.name_ar,
          }))}
        />
        <SelectFilter
          value={buildingId}
          onChange={resetPage(setBuildingId)}
          label={t("units.building")}
          options={(buildings.data?.items ?? [])
            .filter((building) => propertyId === "all" || building.property_id === propertyId)
            .map((building) => ({ value: building.id, label: building.name_ar }))}
        />
        <SelectFilter
          value={unitId}
          onChange={resetPage(setUnitId)}
          label={t("units.name")}
          options={(units.data?.items ?? [])
            .filter((unit) => propertyId === "all" || unit.property_id === propertyId)
            .map((unit) => ({ value: unit.id, label: unit.name }))}
        />
        <SelectFilter
          value={priority}
          onChange={resetPage(setPriority)}
          label={t("maintenance.priority")}
          options={MAINTENANCE_PRIORITIES.map((value) => ({
            value,
            label: t(`maintenancePriority.${value}`),
          }))}
        />
        <SelectFilter
          value={status}
          onChange={resetPage(setStatus)}
          label={t("common.status")}
          options={MAINTENANCE_STATUSES.map((value) => ({
            value,
            label: t(`maintenanceStatus.${value}`),
          }))}
        />
      </div>
      {permissions.can(PERMISSIONS.MAINTENANCE_DELETE) && (
        <BulkDeleteBar
          selected={selected}
          clear={() => setSelected([])}
          deleteOne={(id) => remove.mutateAsync(id).then(() => undefined)}
          entityLabel={t("maintenance.title")}
        />
      )}
      <div className="overflow-hidden rounded-xl border bg-card">
        <TableState
          loading={requests.isLoading}
          error={Boolean(requests.error)}
          empty={!requests.data?.items.length}
        >
          {isMobile ? (
            <div className="p-3">
              <MobileCardList
                items={requests.data?.items ?? []}
                keyFor={(x) => x.id}
                renderCard={(request) => (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{request.title}</p>
                        <p className="font-mono text-xs text-muted-foreground">{request.code}</p>
                      </div>
                      <Badge variant="secondary">{t(`maintenanceStatus.${request.status}`)}</Badge>
                    </div>
                    <CardField label={t("units.property")}>
                      {propertyName.get(request.property_id) ?? "—"}
                    </CardField>
                    <CardField label={t("units.name")}>
                      {unitName.get(request.unit_id ?? "") ?? "—"}
                    </CardField>
                    <CardField label={t("maintenance.priority")}>
                      {t(`maintenancePriority.${request.priority}`)}
                    </CardField>
                    <div className="flex justify-end gap-1 border-t pt-2">
                      <TableActionButton action="view" onClick={() => setViewing(request)} />
                      <TableActionButton
                        action="edit"
                        disabled={!permissions.can(PERMISSIONS.MAINTENANCE_UPDATE)}
                        onClick={() => {
                          setEditing(request);
                          setDialog(true);
                        }}
                      />
                      <TableActionButton
                        action="delete"
                        disabled={!permissions.can(PERMISSIONS.MAINTENANCE_DELETE)}
                        onClick={() => setDeleteTarget(request)}
                      />
                    </div>
                  </>
                )}
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={
                        (requests.data?.items.length ?? 0) > 0 &&
                        selected.length === (requests.data?.items.length ?? 0)
                      }
                      onCheckedChange={(v) =>
                        setSelected(v ? (requests.data?.items ?? []).map((x) => x.id) : [])
                      }
                    />
                  </TableHead>
                  <TableHead>#</TableHead>
                  <TableHead>{t("common.code")}</TableHead>
                  <TableHead>{t("maintenance.requestTitle")}</TableHead>
                  <TableHead>{t("units.property")}</TableHead>
                  <TableHead>{t("units.building")}</TableHead>
                  <TableHead>{t("units.name")}</TableHead>
                  <TableHead>{t("maintenance.priority")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.data?.items.map((request, index) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.includes(request.id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) =>
                            v ? [...prev, request.id] : prev.filter((x) => x !== request.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{request.code}</TableCell>
                    <TableCell className="font-medium">{request.title}</TableCell>
                    <TableCell>{propertyName.get(request.property_id) ?? "—"}</TableCell>
                    <TableCell>{buildingName.get(request.building_id ?? "") ?? "—"}</TableCell>
                    <TableCell>{unitName.get(request.unit_id ?? "") ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {t(`maintenancePriority.${request.priority}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`maintenanceStatus.${request.status}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <TableActionButton action="view" onClick={() => setViewing(request)} />
                        <TableActionButton
                          action="edit"
                          disabled={!permissions.can(PERMISSIONS.MAINTENANCE_UPDATE)}
                          onClick={() => {
                            setEditing(request);
                            setDialog(true);
                          }}
                        />
                        <TableActionButton
                          action="delete"
                          disabled={!permissions.can(PERMISSIONS.MAINTENANCE_DELETE)}
                          onClick={() => setDeleteTarget(request)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableState>
        <Pager page={page} pageSize={10} count={requests.data?.count ?? 0} setPage={setPage} />
      </div>
      <MaintenanceFormDialog
        open={dialog}
        onOpenChange={setDialog}
        form={form}
        editingCode={editing?.code ?? null}
        properties={properties.data?.items ?? []}
        buildings={formBuildings}
        units={formUnits}
        onSave={save}
        pending={create.isPending || update.isPending}
      />
      <MaintenanceViewDialog
        viewing={viewing}
        onClose={() => setViewing(null)}
        propertyName={propertyName}
        buildingName={buildingName}
        unitName={unitName}
      />
      <CsvImportDialog entity="maintenance" open={importOpen} onOpenChange={setImportOpen} />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={remove.isPending}
        title={t("phase2.deleteTitle")}
        description={t("maintenance.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDelete}
      />
    </div>
  );
}
