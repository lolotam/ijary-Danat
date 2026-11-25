import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type MaintenanceRequest } from "@/hooks/useMaintenance";
import { useI18n } from "@/i18n/provider";

/** حوار عرض طلب صيانة للقراءة فقط، بأسماء العقار والمبنى والوحدة. */
export function MaintenanceViewDialog({
  viewing,
  onClose,
  propertyName,
  buildingName,
  unitName,
}: {
  viewing: MaintenanceRequest | null;
  onClose: () => void;
  propertyName: Map<string, string>;
  buildingName: Map<string, string>;
  unitName: Map<string, string>;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("maintenance.view")}</DialogTitle>
          <DialogDescription>{viewing?.code}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">{t("maintenance.requestTitle")}:</span>{" "}
            {viewing?.title}
          </p>
          <p>
            <span className="text-muted-foreground">{t("units.property")}:</span>{" "}
            {propertyName.get(viewing?.property_id ?? "") ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">{t("units.building")}:</span>{" "}
            {buildingName.get(viewing?.building_id ?? "") ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">{t("units.name")}:</span>{" "}
            {unitName.get(viewing?.unit_id ?? "") ?? "—"}
          </p>
          <p>
            <span className="text-muted-foreground">{t("maintenance.priority")}:</span>{" "}
            {viewing ? t(`maintenancePriority.${viewing.priority}`) : "—"}
          </p>
          <p>
            <span className="text-muted-foreground">{t("common.status")}:</span>{" "}
            {viewing ? t(`maintenanceStatus.${viewing.status}`) : "—"}
          </p>
          <p className="sm:col-span-2">
            <span className="text-muted-foreground">{t("maintenance.description")}:</span>{" "}
            {viewing?.description ?? "—"}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
