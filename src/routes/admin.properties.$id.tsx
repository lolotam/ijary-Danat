import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Building2, Eye, Plus, Printer } from "lucide-react";
import { toast } from "sonner";

import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { DeleteConfirmation, TableState } from "@/components/admin/Phase2Ui";
import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { TableActionButton } from "@/components/admin/TableActionButton";
import { UnitFormDialog } from "@/components/admin/UnitFormDialog";
import { useActiveContractRent } from "@/hooks/useActiveContractRent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCatalogueLabel } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperty, useUpdateProperty } from "@/hooks/useProperties";
import { useDeleteUnit, useUnits, type Unit } from "@/hooks/useUnits";
import { useI18n } from "@/i18n/provider";
import { propertyUnitSortValue } from "@/lib/adminTableSortValues";
import { PERMISSIONS } from "@/lib/permissions";
import { formatAmount } from "@/lib/money";
import { countUnitsByType } from "@/lib/unitTypeCounts";
import { auditPrint } from "@/lib/exportAudit";

export const Route = createFileRoute("/admin/properties/$id")({ component: PropertyDetailPage });

function PropertyDetailPage() {
  const { id } = Route.useParams();
  const { t, locale } = useI18n();
  const permissions = usePermissions();
  const property = useProperty(id);
  const updateProperty = useUpdateProperty();
  const units = useUnits(
    { propertyId: id, pageSize: 200 },
    permissions.can(PERMISSIONS.UNITS_READ),
  );
  const deleteUnit = useDeleteUnit();
  const unitFloorLabel = useCatalogueLabel("unit_floors", "unitFloor");
  const propertyTypeLabel = useCatalogueLabel("property_types", "propertyType");
  const unitTypeLabel = useCatalogueLabel("unit_types", "unitType");
  const [unitDialog, setUnitDialog] = useState(false);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);

  /** إيجار الوحدة قيد التعديل من عقدها النشط، إن وُجد. */
  const editedUnitRent =
    useActiveContractRent(editingUnit?.id, permissions.can(PERMISSIONS.CONTRACTS_READ)).data ??
    null;
  const [deleteTarget, setDeleteTarget] = useState<Unit | null>(null);
  const {
    sort,
    toggle,
    sorted: sortedUnits,
  } = useTableSort(units.data?.items ?? [], propertyUnitSortValue);

  const summary = useMemo(() => {
    const items = units.data?.items ?? [];
    return {
      total: items.length,
      occupied: items.filter((u) => u.occupant).length,
      vacant: items.filter((u) => !u.occupant).length,
      totalRent: items.reduce((s, u) => s + Number(u.default_rent ?? 0), 0),
      commercial: countUnitsByType(items, "commercial"),
      shop: countUnitsByType(items, "shop"),
    };
  }, [units.data]);

  async function confirmDeleteUnit() {
    if (!deleteTarget) return;
    try {
      await deleteUnit.mutateAsync(deleteTarget.id);
      toast.success(t("phase2.deleted"));
      setDeleteTarget(null);
    } catch (error) {
      toast.error(t("phase2.deleteError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function savePropertyImage(url: string) {
    try {
      await updateProperty.mutateAsync({ id, updates: { image_url: url.trim() || null } });
      toast.success(t("phase2.saved"));
    } catch (error) {
      toast.error(t("phase2.saveError"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }

  if (!permissions.can(PERMISSIONS.PROPERTIES_READ)) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }
  if (property.isLoading) return <p>{t("common.loading")}</p>;
  if (!property.data) return <p>{t("common.notFound")}</p>;

  const p = property.data;
  const name = locale === "ar" ? p.name_ar : (p.name_en ?? p.name_ar);
  const address = locale === "ar" ? p.address_ar : (p.address_en ?? p.address_ar);
  const description = locale === "ar" ? p.description_ar : (p.description_en ?? p.description_ar);

  return (
    <div className="space-y-6 print:space-y-3">
      <Toaster richColors position="top-center" />
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/properties">
              <ArrowLeft className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
          <h1 className="mt-1 text-2xl font-semibold">{name}</h1>
          <p className="text-sm text-muted-foreground font-mono">{p.code}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!permissions.can(PERMISSIONS.UNITS_CREATE)}
            onClick={() => {
              setEditingUnit(null);
              setUnitDialog(true);
            }}
          >
            <Plus className="size-4" />
            {t("units.add")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              auditPrint("property", id);
              window.print();
            }}
          >
            <Printer className="size-4" />
            {t("common.print")}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2 overflow-hidden">
          {p.image_url ? (
            <img src={p.image_url} alt={name} className="h-56 w-full object-cover" />
          ) : (
            <div className="h-56 w-full bg-muted flex items-center justify-center">
              <Building2 className="size-12 text-muted-foreground" />
            </div>
          )}
          {permissions.can(PERMISSIONS.PROPERTIES_UPDATE) && (
            <div className="border-b p-4 print:hidden">
              <Label className="mb-2 block text-xs text-muted-foreground">
                {t("common.imageUrl")}
              </Label>
              <ImageSourceInput
                value={p.image_url ?? ""}
                onChange={savePropertyImage}
                bucket="property-images"
                folder="properties"
              />
            </div>
          )}
          <CardHeader>
            <CardTitle>{name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{propertyTypeLabel(p.type)}</Badge>
              <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge>
              {p.area ? <Badge variant="outline">{p.area} m²</Badge> : null}
            </div>
            {p.paci_no ? <Row label={t("properties.paciNo")} value={p.paci_no} /> : null}
            {p.floor_count != null ? (
              <Row label={t("properties.floorCount")} value={p.floor_count} />
            ) : null}
            {p.unit_count != null ? (
              <Row label={t("properties.unitCount")} value={p.unit_count} />
            ) : null}
            {address ? <p className="text-muted-foreground">{address}</p> : null}
            {description ? <p>{description}</p> : null}
            {p.location_url && /^https?:\/\//i.test(p.location_url) ? (
              <a
                href={p.location_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                {t("common.location")}
              </a>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("common.summary")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label={t("units.title")} value={summary.total} />
            <Row label={t("units.occupied")} value={summary.occupied} />
            <Row label={t("units.vacant")} value={summary.vacant} />
            <Row label={t("units.commercialCount")} value={summary.commercial} />
            <Row label={t("units.shopCount")} value={summary.shop} />
            <Row
              label={t("properties.floorCount")}
              value={p.floor_count != null ? p.floor_count : "—"}
            />
            <Row label={t("units.totalRent")} value={formatAmount(summary.totalRent, locale)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t("units.title")}</CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="print:hidden"
            disabled={!permissions.can(PERMISSIONS.UNITS_CREATE)}
            onClick={() => {
              setEditingUnit(null);
              setUnitDialog(true);
            }}
          >
            <Plus className="size-4" />
            {t("units.add")}
          </Button>
        </CardHeader>
        <CardContent>
          <TableState
            loading={units.isLoading}
            error={Boolean(units.error)}
            empty={(units.data?.items.length ?? 0) === 0}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="code" sort={sort} toggle={toggle}>
                    {t("common.code")}
                  </SortableHead>
                  <SortableHead sortKey="paci_no" sort={sort} toggle={toggle}>
                    {t("units.paciNo")}
                  </SortableHead>
                  <SortableHead sortKey="name" sort={sort} toggle={toggle}>
                    {t("common.name")}
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
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedUnits.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.code}</TableCell>
                    <TableCell className="font-mono text-xs">{u.paci_no ?? "—"}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{unitTypeLabel(u.type)}</Badge>
                    </TableCell>
                    <TableCell>{u.floor ? unitFloorLabel(u.floor) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={u.status === "vacant" ? "default" : "secondary"}>
                        {u.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.default_rent ? formatAmount(u.default_rent, locale) : "—"}
                    </TableCell>
                    <TableCell>
                      {u.occupant ? (
                        <Link
                          to="/admin/tenants/$id"
                          params={{ id: u.occupant.id }}
                          className="text-primary underline"
                        >
                          {u.occupant.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <TableActionButton action="view" asChild>
                          <Link to="/admin/units/$id" params={{ id: u.id }}>
                            <Eye className="size-4" />
                          </Link>
                        </TableActionButton>
                        <TableActionButton
                          action="edit"
                          disabled={!permissions.can(PERMISSIONS.UNITS_UPDATE)}
                          onClick={() => {
                            setEditingUnit(u);
                            setUnitDialog(true);
                          }}
                        />
                        <TableActionButton
                          action="delete"
                          disabled={!permissions.can(PERMISSIONS.UNITS_DELETE)}
                          onClick={() => setDeleteTarget(u)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableState>
        </CardContent>
      </Card>

      <UnitFormDialog
        open={unitDialog}
        onOpenChange={(open) => {
          setUnitDialog(open);
          if (!open) setEditingUnit(null);
        }}
        editing={editingUnit}
        onSaved={setEditingUnit}
        activeContractRent={editedUnitRent}
        lockedPropertyId={id}
      />
      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteUnit.isPending}
        title={t("phase2.deleteTitle")}
        description={t("units.deleteDescription")}
        close={() => setDeleteTarget(null)}
        confirm={confirmDeleteUnit}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between border-b pb-2 last:border-none">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
