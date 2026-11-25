import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import {
  ActiveBadge,
  ElectricityField,
  OwnershipBadge,
} from "@/components/admin/electricity/ElectricityUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateElectricityMeter,
  useDeleteElectricityMeter,
  useElectricityMeters,
  useUpdateElectricityMeter,
  type ElectricityMeter,
  type ElectricityMeterWithRelations,
} from "@/hooks/useElectricityMeters";
import { useElectricityTariffs } from "@/hooks/useElectricityTariffs";
import { usePermissions } from "@/hooks/usePermissions";
import { useUnits } from "@/hooks/useUnits";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { ElectricityMeterOwnership } from "@/integrations/supabase/database.types";
import { PERMISSIONS } from "@/lib/permissions";

const meterSchema = z.object({
  installed_at: z.string(),
  is_active: z.boolean(),
  meter_number: z.string(),
  notes: z.string(),
  ownership: z.enum(["company_owned", "tenant_owned"]),
  tariff_id: z.string(),
  unit_id: z.string().uuid(),
});

type MeterForm = z.infer<typeof meterSchema>;

const emptyMeter = (): MeterForm => ({
  installed_at: "",
  is_active: true,
  meter_number: "",
  notes: "",
  ownership: "company_owned",
  tariff_id: "",
  unit_id: "",
});

export function MetersTab() {
  const { locale, t } = useI18n();
  const permissions = usePermissions();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const meters = useElectricityMeters({ page, pageSize: 10, search: debouncedSearch });
  const tariffs = useElectricityTariffs({ page: 1, pageSize: 500 });
  const units = useUnits({ page: 1, pageSize: 500 });
  const createMeter = useCreateElectricityMeter();
  const updateMeter = useUpdateElectricityMeter();
  const deleteMeter = useDeleteElectricityMeter();
  const [formOpen, setFormOpen] = useState(false);
  const [target, setTarget] = useState<ElectricityMeterWithRelations | null>(null);
  /**
   * معرّف العدّاد الذي أنشأه هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * Not `setTarget(saved)`: `target` is an `ElectricityMeterWithRelations` and
   * the mutation returns a bare `ElectricityMeter`.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ElectricityMeter | null>(null);
  const form = useForm<MeterForm>({
    resolver: zodResolver(meterSchema),
    defaultValues: emptyMeter(),
  });

  const canCreate = permissions.isAdmin && permissions.can(PERMISSIONS.ELECTRICITY_CREATE);
  const canUpdate = permissions.isAdmin && permissions.can(PERMISSIONS.ELECTRICITY_UPDATE);
  const canDelete = permissions.isAdmin && permissions.can(PERMISSIONS.ELECTRICITY_DELETE);

  const openForm = (meter?: ElectricityMeterWithRelations) => {
    setCreatedId(null);
    setTarget(meter ?? null);
    form.reset(
      meter
        ? {
            installed_at: meter.installed_at ?? "",
            is_active: meter.is_active,
            meter_number: meter.meter_number ?? "",
            notes: meter.notes ?? "",
            ownership: meter.ownership,
            tariff_id: meter.tariff_id ?? "",
            unit_id: meter.unit_id,
          }
        : emptyMeter(),
    );
    setFormOpen(true);
  };

  const saveMeter = form.handleSubmit(async (meterForm) => {
    const payload = {
      installed_at: meterForm.installed_at || null,
      is_active: meterForm.is_active,
      meter_number: meterForm.meter_number.trim() || null,
      notes: meterForm.notes.trim() || null,
      ownership: meterForm.ownership,
      tariff_id: meterForm.tariff_id || null,
      unit_id: meterForm.unit_id,
    };
    // Coalesced before the branch: the form stays open after a create and
    // `target` is still null then, so the next Save must update the row this
    // one inserted.
    const editingId = target?.id ?? createdId;
    try {
      if (editingId) await updateMeter.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await createMeter.mutateAsync(payload);
        setCreatedId(created.id);
      }
      form.reset(meterForm);
      toast.success(t("common.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        <Input
          className="sm:max-w-sm"
          value={search}
          placeholder={t("common.search")}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <Button disabled={!canCreate} onClick={() => openForm()}>
          <Plus className="size-4" />
          {t("electricity.meters.add")}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-0" />
        <CardContent className="p-0">
          <TableState
            loading={meters.isLoading}
            error={meters.isError}
            empty={!meters.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{t("electricity.unit")}</TableHead>
                    <TableHead>{t("electricity.meterNumber")}</TableHead>
                    <TableHead>{t("electricity.ownership")}</TableHead>
                    <TableHead>{t("electricity.tariff")}</TableHead>
                    <TableHead>{t("common.status")}</TableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(meters.data?.items ?? []).map((meter, index) => (
                    <TableRow key={meter.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell>
                        {meter.unit ? `${meter.unit.code} — ${meter.unit.name}` : "—"}
                      </TableCell>
                      <TableCell>{meter.meter_number ?? "—"}</TableCell>
                      <TableCell>
                        <OwnershipBadge ownership={meter.ownership} />
                      </TableCell>
                      <TableCell>
                        {meter.tariff
                          ? `${meter.tariff.code} — ${locale === "ar" ? meter.tariff.name_ar : (meter.tariff.name_en ?? meter.tariff.name_ar)}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <ActiveBadge active={meter.is_active} />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            title={t("common.edit")}
                            size="icon"
                            variant="ghost"
                            disabled={!canUpdate}
                            onClick={() => openForm(meter)}
                          >
                            <Pencil className="size-4" />
                            <span className="sr-only">{t("common.edit")}</span>
                          </Button>
                          <Button
                            title={t("common.delete")}
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            disabled={!canDelete}
                            onClick={() => setDeleteTarget(meter)}
                          >
                            <Trash2 className="size-4" />
                            <span className="sr-only">{t("common.delete")}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableState>
          <Pager page={page} pageSize={10} count={meters.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {target ? t("electricity.meters.edit") : t("electricity.meters.add")}
            </DialogTitle>
            <DialogDescription>{t("electricity.meters.formHelp")}</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={saveMeter}>
            <ElectricityField
              required
              label={t("electricity.unit")}
              error={form.formState.errors.unit_id?.message}
            >
              <Select
                value={form.watch("unit_id")}
                onValueChange={(unitId) => {
                  form.setValue("unit_id", unitId, { shouldValidate: true });
                  const unit = units.data?.items.find((candidate) => candidate.id === unitId);
                  if (unit) form.setValue("ownership", unit.electricity_meter_ownership);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(units.data?.items ?? []).map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.code} — {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ElectricityField>
            <ElectricityField label={t("electricity.meterNumber")}>
              <Input {...form.register("meter_number")} />
            </ElectricityField>
            <ElectricityField required label={t("electricity.ownership")}>
              <Select
                value={form.watch("ownership")}
                onValueChange={(ownership) =>
                  form.setValue("ownership", ownership as ElectricityMeterOwnership)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="company_owned">
                    {t("electricity.ownership.company_owned")}
                  </SelectItem>
                  <SelectItem value="tenant_owned">
                    {t("electricity.ownership.tenant_owned")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </ElectricityField>
            <ElectricityField label={t("electricity.tariff")}>
              <Select
                value={form.watch("tariff_id") || "none"}
                onValueChange={(tariffId) =>
                  form.setValue("tariff_id", tariffId === "none" ? "" : tariffId)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("common.none")}</SelectItem>
                  {(tariffs.data?.items ?? []).map((tariff) => (
                    <SelectItem key={tariff.id} value={tariff.id}>
                      {tariff.code} —{" "}
                      {locale === "ar" ? tariff.name_ar : (tariff.name_en ?? tariff.name_ar)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ElectricityField>
            <ElectricityField label={t("electricity.installedAt")}>
              <DateInput
                value={form.watch("installed_at") ?? ""}
                onChange={(value) => form.setValue("installed_at", value, { shouldValidate: true })}
              />
            </ElectricityField>
            <div className="flex items-center justify-between rounded-md border p-3">
              <span className="text-sm font-medium">{t("electricity.active")}</span>
              <Switch
                checked={form.watch("is_active")}
                onCheckedChange={(checked) => form.setValue("is_active", checked)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <ElectricityField label={t("common.notes")}>
                <Textarea {...form.register("notes")} />
              </ElectricityField>
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={createMeter.isPending || updateMeter.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteMeter.isPending}
        title={t("electricity.meters.deleteTitle")}
        description={t("electricity.meters.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteMeter.mutateAsync(deleteTarget);
            setDeleteTarget(null);
            toast.success(t("common.saved"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </div>
  );
}
