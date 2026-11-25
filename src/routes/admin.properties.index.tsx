import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Download, LayoutGrid, Plus, Table as TableIcon, Upload } from "lucide-react";
import { useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { CsvImportDialog } from "@/components/admin/CsvImportDialog";
import { EntityLink } from "@/components/admin/EntityLink";
import {
  DeleteConfirmation,
  ModuleHeader,
  Pager,
  SelectFilter,
  TableState,
} from "@/components/admin/Phase2Ui";
import { PropertyCards } from "@/components/admin/properties/PropertyCards";
import { BulkDeleteBar } from "@/components/admin/BulkDeleteBar";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
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
import { useCompany } from "@/hooks/useCompany";
import { useCatalogueLabel, useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import {
  useCreateProperty,
  useDeleteProperty,
  useProperties,
  usePropertyExport,
  useUpdateProperty,
  type Property,
} from "@/hooks/useProperties";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { ImportEntity } from "@/lib/bulkImportSchemas";
import { downloadImportTemplate } from "@/lib/bulkImportTemplates";
import { mapCatalogueOptions } from "@/lib/commercialActivityOptions";
import { exportRecordsToCsv } from "@/lib/csv";
import { PERMISSIONS } from "@/lib/permissions";
import { propertyFormSchema, type PropertyFormValues } from "@/lib/propertyForm";
import { showError } from "@/lib/toastError";
import { PropertyFormDialog } from "@/components/admin/properties/PropertyFormDialog";

export const Route = createFileRoute("/admin/properties/")({ component: PropertiesPage });

const propertyDefaults: PropertyFormValues = {
  name_ar: "",
  name_en: "",
  paci_no: "",
  type: "compound",
  address_ar: "",
  address_en: "",
  location_url: "",
  area: undefined,
  floor_count: undefined,
  unit_count: undefined,
  description_ar: "",
  description_en: "",
  image_url: "",
  status: "active",
};
const nullableText = (value: string) => value.trim() || null;

function PropertiesPage() {
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [importEntity, setImportEntity] = useState<ImportEntity | null>(null);
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  /**
   * معرّف العقار الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * The dialog no longer closes on save, so a second Save without this would
   * insert a duplicate property.
   */
  const [createdPropertyId, setCreatedPropertyId] = useState<string | null>(null);
  const [propertyDialog, setPropertyDialog] = useState(false);
  const [deleteProperty, setDeleteProperty] = useState<Property | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const propertyFilters = {
    search: debouncedSearch,
    type: typeFilter === "all" ? undefined : (typeFilter as Property["type"]),
    status: statusFilter === "all" ? undefined : (statusFilter as Property["status"]),
  };
  const properties = useProperties(
    { page, pageSize: 10, ...propertyFilters },
    permissions.can(PERMISSIONS.PROPERTIES_READ),
  );
  const propertyExport = usePropertyExport(
    propertyFilters,
    permissions.can(PERMISSIONS.PROPERTIES_EXPORT),
  );
  const {
    sort,
    toggle,
    sorted: sortedProperties,
  } = useTableSort(properties.data?.items ?? [], (property, key) =>
    key === "units"
      ? property.occupiedUnits + property.vacantUnits
      : (property as unknown as Record<string, unknown>)[key],
  );
  const createProperty = useCreateProperty();
  const updateProperty = useUpdateProperty();
  const removeProperty = useDeleteProperty();
  const company = useCompany();
  const form = useForm<PropertyFormValues>({
    resolver: zodResolver(propertyFormSchema) as Resolver<PropertyFormValues>,
    defaultValues: propertyDefaults,
  });
  const typeValue = form.watch("type");
  // One Name column that follows the UI language. `name_en` is nullable, so
  // Arabic is the fallback rather than rendering an empty cell.
  const nameColumn = locale === "ar" ? "name_ar" : "name_en";
  const propertyName = (property: Property) =>
    locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar);
  const [view, setView] = useState<"cards" | "table">("cards");
  // Free-text type (migration 103) — catalogue directly, NOT useListDrivenOptions.
  const propertyTypeItems = useOptionListItemsByCode("property_types");
  const typeMapped = mapCatalogueOptions(propertyTypeItems.data ?? [], locale);
  if (typeValue && !typeMapped.some((option) => option.value === typeValue)) {
    typeMapped.push({ value: typeValue, label: typeValue });
  }
  const typeOptions = typeMapped;
  // Same catalogue for the stored value: cards and table both rendered the raw
  // dictionary key for any type added after the five seeds.
  const propertyTypeLabel = useCatalogueLabel("property_types", "propertyType");
  useEffect(() => {
    if (!propertyDialog) return;
    // A reopened dialog is a fresh create until it saves again.
    setCreatedPropertyId(null);
    form.reset(
      editingProperty
        ? {
            name_ar: editingProperty.name_ar,
            name_en: editingProperty.name_en ?? "",
            paci_no: editingProperty.paci_no ?? "",
            type: editingProperty.type,
            address_ar: editingProperty.address_ar ?? "",
            address_en: editingProperty.address_en ?? "",
            location_url: editingProperty.location_url ?? "",
            area: editingProperty.area ?? undefined,
            floor_count: editingProperty.floor_count ?? undefined,
            unit_count: editingProperty.unit_count ?? undefined,
            description_ar: editingProperty.description_ar ?? "",
            description_en: editingProperty.description_en ?? "",
            image_url: editingProperty.image_url ?? "",
            status: editingProperty.status,
          }
        : propertyDefaults,
    );
  }, [editingProperty, form, propertyDialog]);

  /** يحفظ العقار: تعديل إن سبق إنشاؤه أو اختير، وإلا إضافة. */
  async function save(values: PropertyFormValues) {
    const payload = {
      ...values,
      name_en: nullableText(values.name_en),
      paci_no: nullableText(values.paci_no),
      address_ar: nullableText(values.address_ar),
      address_en: nullableText(values.address_en),
      location_url: nullableText(values.location_url),
      description_ar: nullableText(values.description_ar),
      description_en: nullableText(values.description_en),
      image_url: nullableText(values.image_url),
      company_id: company.data?.id ?? null,
    };
    // Coalesced before the branch: after a create `editingProperty` is still
    // null while the form stays open, so the next Save must update the row this
    // one inserted.
    const editingId = editingProperty?.id ?? createdPropertyId;
    try {
      if (editingId) await updateProperty.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await createProperty.mutateAsync(payload);
        setCreatedPropertyId(created.id);
      }
      form.reset(values);
      toast.success(t("phase2.saved"));
    } catch (error) {
      showError(t("phase2.saveError"), error);
    }
  }

  /** يحذف العقار المؤكَّد. */
  async function confirmDelete() {
    if (!deleteProperty) return;
    try {
      await removeProperty.mutateAsync(deleteProperty.id);
      toast.success(t("phase2.deleted"));
      setDeleteProperty(null);
    } catch (error) {
      showError(t("phase2.deleteError"), error);
    }
  }

  function openProperty(property: Property) {
    navigate({ to: "/admin/properties/$id", params: { id: property.id } });
  }

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.PROPERTIES_READ))
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  const statusOptions = ["active", "inactive", "archived"].map((value) => ({
    value,
    label: t(`status.${value}`),
  }));
  const resetPage =
    (setter: (value: string) => void, setPageValue: (page: number) => void) => (value: string) => {
      setter(value);
      setPageValue(1);
    };

  function exportProperties() {
    exportRecordsToCsv(
      (propertyExport.data?.items ?? []).map((property) => ({
        code: property.code,
        name_ar: property.name_ar,
        name_en: property.name_en ?? "",
        type: property.type,
        address_ar: property.address_ar ?? "",
        address_en: property.address_en ?? "",
        location_url: property.location_url ?? "",
        area: property.area ?? "",
        description_ar: property.description_ar ?? "",
        description_en: property.description_en ?? "",
        image_url: property.image_url ?? "",
        status: property.status,
        units: property.occupiedUnits + property.vacantUnits,
      })),
      "properties.csv",
      locale,
    );
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("properties.title")}
        subtitle={t("properties.subtitle")}
        actions={
          <>
            <Button variant="outline" onClick={() => downloadImportTemplate("properties", locale)}>
              <Download className="size-4" />
              {t("import.downloadTemplate")}
            </Button>
            <Button
              variant="outline"
              disabled={!permissions.can(PERMISSIONS.PROPERTIES_CREATE)}
              onClick={() => setImportEntity("properties")}
            >
              <Upload className="size-4" />
              {t("common.import")}
            </Button>
            <Button
              variant="outline"
              disabled={!propertyExport.data?.items.length}
              onClick={exportProperties}
            >
              <Download className="size-4" />
              {t("export.csv")}
            </Button>
            <Button
              disabled={!permissions.can(PERMISSIONS.PROPERTIES_CREATE)}
              onClick={() => {
                setEditingProperty(null);
                setPropertyDialog(true);
              }}
            >
              <Plus className="size-4" />
              {t("properties.add")}
            </Button>
          </>
        }
      />
      <div className="grid gap-3 md:grid-cols-3">
        <Input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={t("properties.search")}
        />
        <SelectFilter
          value={typeFilter}
          onChange={resetPage(setTypeFilter, setPage)}
          label={t("common.type")}
          options={typeOptions}
        />
        <SelectFilter
          value={statusFilter}
          onChange={resetPage(setStatusFilter, setPage)}
          label={t("common.status")}
          options={statusOptions}
        />
      </div>
      {permissions.can(PERMISSIONS.PROPERTIES_DELETE) && (
        <BulkDeleteBar
          selected={selected}
          clear={() => setSelected([])}
          deleteOne={(id) => removeProperty.mutateAsync(id).then(() => undefined)}
          entityLabel={t("properties.title")}
        />
      )}
      <div className="flex justify-end">
        <div className="inline-flex overflow-hidden rounded-lg border">
          <Button
            type="button"
            size="sm"
            variant={view === "cards" ? "default" : "ghost"}
            className="rounded-none"
            onClick={() => setView("cards")}
          >
            <LayoutGrid className="size-4" />
            {t("properties.cardView")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={view === "table" ? "default" : "ghost"}
            className="rounded-none"
            onClick={() => setView("table")}
          >
            <TableIcon className="size-4" />
            {t("properties.tableView")}
          </Button>
        </div>
      </div>
      {view === "cards" ? (
        <div>
          <TableState
            loading={properties.isLoading}
            error={Boolean(properties.error)}
            empty={!properties.data?.items.length}
          >
            <PropertyCards
              properties={properties.data?.items ?? []}
              canRead={permissions.can(PERMISSIONS.PROPERTIES_READ)}
              canUpdate={permissions.can(PERMISSIONS.PROPERTIES_UPDATE)}
              canDelete={permissions.can(PERMISSIONS.PROPERTIES_DELETE)}
              typeLabel={propertyTypeLabel}
              onOpen={openProperty}
              onEdit={(property) => {
                setEditingProperty(property);
                setPropertyDialog(true);
              }}
              onDelete={setDeleteProperty}
            />
          </TableState>
          <Pager page={page} pageSize={10} count={properties.data?.count ?? 0} setPage={setPage} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <TableState
            loading={properties.isLoading}
            error={Boolean(properties.error)}
            empty={!properties.data?.items.length}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={
                        (properties.data?.items.length ?? 0) > 0 &&
                        selected.length === (properties.data?.items.length ?? 0)
                      }
                      onCheckedChange={(v) =>
                        setSelected(v ? (properties.data?.items ?? []).map((x) => x.id) : [])
                      }
                    />
                  </TableHead>
                  <TableHead>#</TableHead>
                  <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey={nameColumn} sort={sort} toggle={toggle}>
                    {t("common.name")}
                  </SortableHead>
                  <SortableHead sortKey="type" sort={sort} toggle={toggle}>
                    {t("common.type")}
                  </SortableHead>
                  <SortableHead sortKey="units" sort={sort} toggle={toggle}>
                    {t("properties.unitsCount")}
                  </SortableHead>
                  <SortableHead sortKey="area" sort={sort} toggle={toggle}>
                    {t("common.area")}
                  </SortableHead>
                  <SortableHead sortKey="status" sort={sort} toggle={toggle}>
                    {t("common.status")}
                  </SortableHead>
                  <TableHead>{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProperties.map((property, index) => (
                  <TableRow
                    key={property.id}
                    className="cursor-pointer"
                    onClick={() => openProperty(property)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.includes(property.id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) =>
                            v ? [...prev, property.id] : prev.filter((x) => x !== property.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{property.code}</TableCell>
                    <TableCell className="font-medium">
                      <EntityLink
                        kind="property"
                        id={property.id}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {propertyName(property)}
                      </EntityLink>
                    </TableCell>
                    <TableCell>{propertyTypeLabel(property.type)}</TableCell>
                    <TableCell>{property.occupiedUnits + property.vacantUnits}</TableCell>
                    <TableCell>{property.area ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`status.${property.status}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1" onClick={(event) => event.stopPropagation()}>
                        <TableActionButton
                          action="edit"
                          disabled={!permissions.can(PERMISSIONS.PROPERTIES_UPDATE)}
                          onClick={() => {
                            setEditingProperty(property);
                            setPropertyDialog(true);
                          }}
                        />
                        <TableActionButton
                          action="delete"
                          disabled={!permissions.can(PERMISSIONS.PROPERTIES_DELETE)}
                          onClick={() => setDeleteProperty(property)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableState>
          <Pager page={page} pageSize={10} count={properties.data?.count ?? 0} setPage={setPage} />
        </div>
      )}
      {importEntity && (
        <CsvImportDialog
          entity={importEntity}
          open={Boolean(importEntity)}
          onOpenChange={(open) => {
            if (!open) setImportEntity(null);
          }}
        />
      )}
      <PropertyFormDialog
        open={propertyDialog}
        onOpenChange={setPropertyDialog}
        form={form}
        editingCode={editingProperty?.code ?? null}
        typeOptions={typeOptions}
        statusOptions={statusOptions}
        onSave={save}
        pending={createProperty.isPending || updateProperty.isPending}
      />
      <DeleteConfirmation
        open={Boolean(deleteProperty)}
        pending={removeProperty.isPending}
        title={t("phase2.deleteTitle")}
        description={t("phase2.deleteDescription")}
        close={() => setDeleteProperty(null)}
        confirm={confirmDelete}
      />
    </div>
  );
}
