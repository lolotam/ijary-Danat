import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import { ElectricityField } from "@/components/admin/electricity/ElectricityUi";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useElectricityMeters } from "@/hooks/useElectricityMeters";
import {
  useCreateMeterReading,
  useDeleteMeterReading,
  useMeterReadings,
  usePreviousMeterReading,
  useUpdateMeterReading,
  type MeterReading,
  type MeterReadingWithRelations,
} from "@/hooks/useMeterReadings";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import { formatElectricityNumber } from "@/lib/electricity";
import { PERMISSIONS } from "@/lib/permissions";

const today = new Date();

const readingSchema = z.object({
  meter_id: z.string().uuid(),
  note: z.string(),
  period_month: z.coerce.number().int().min(1).max(12),
  period_year: z.coerce.number().int().min(2000).max(2200),
  reading: z.coerce.number().finite().nonnegative(),
  reading_date: z.string().date(),
});

type ReadingForm = z.infer<typeof readingSchema>;

const emptyReading = (): ReadingForm => ({
  meter_id: "",
  note: "",
  period_month: today.getMonth() + 1,
  period_year: today.getFullYear(),
  reading: 0,
  reading_date: today.toISOString().slice(0, 10),
});

export function ReadingsTab() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const readings = useMeterReadings({ page, pageSize: 10, search: debouncedSearch });
  const meters = useElectricityMeters({ page: 1, pageSize: 500 });
  const createReading = useCreateMeterReading();
  const updateReading = useUpdateMeterReading();
  const deleteReading = useDeleteMeterReading();
  const [formOpen, setFormOpen] = useState(false);
  const [target, setTarget] = useState<MeterReadingWithRelations | null>(null);
  /**
   * معرّف القراءة التي أنشأها هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * Sharpest case in this change: a duplicate insert here violates
   * `unique (meter_id, period_year, period_month)` and surfaces as a save
   * error rather than a silent second row.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MeterReading | null>(null);
  const form = useForm<ReadingForm>({
    resolver: zodResolver(readingSchema),
    defaultValues: emptyReading(),
  });
  const meterId = form.watch("meter_id");
  const periodMonth = Number(form.watch("period_month"));
  const periodYear = Number(form.watch("period_year"));
  const readingValue = Number(form.watch("reading"));
  const previousReading = usePreviousMeterReading({
    meterId,
    periodMonth,
    periodYear,
    // `createdId` belongs here as much as `target`: the form stays open after a
    // create, so if the operator then changes the meter or the period, this
    // reading would be returned as its *own* previous reading — showing a wrong
    // consumption figure, or refusing a valid update as negative consumption.
    excludeId: target?.id ?? createdId ?? undefined,
  });
  const previousValue = previousReading.data?.reading ?? null;
  const consumptionPreview = previousValue === null ? 0 : readingValue - previousValue;

  const openForm = (reading?: MeterReadingWithRelations) => {
    setCreatedId(null);
    setTarget(reading ?? null);
    form.reset(
      reading
        ? {
            meter_id: reading.meter_id,
            note: reading.note ?? "",
            period_month: reading.period_month,
            period_year: reading.period_year,
            reading: reading.reading,
            reading_date: reading.reading_date,
          }
        : emptyReading(),
    );
    setFormOpen(true);
  };

  const saveReading = form.handleSubmit(async (readingForm) => {
    if (consumptionPreview < 0) {
      toast.error(t("electricity.readings.negativeConsumption"));
      return;
    }
    const payload = {
      meter_id: readingForm.meter_id,
      note: readingForm.note.trim() || null,
      period_month: readingForm.period_month,
      period_year: readingForm.period_year,
      reading: readingForm.reading,
      reading_date: readingForm.reading_date,
    };
    // Coalesced before the branch: the form stays open after a create and
    // `target` is still null then, so the next Save must update the row this
    // one inserted.
    const editingId = target?.id ?? createdId;
    try {
      if (editingId) await updateReading.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await createReading.mutateAsync(payload);
        setCreatedId(created.id);
      }
      form.reset(readingForm);
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
        <Button
          disabled={!permissions.can(PERMISSIONS.ELECTRICITY_CREATE)}
          onClick={() => openForm()}
        >
          <Plus className="size-4" />
          {t("electricity.readings.add")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <TableState
            loading={readings.isLoading}
            error={readings.isError}
            empty={!readings.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{t("electricity.meter")}</TableHead>
                    <TableHead>{t("electricity.unit")}</TableHead>
                    <TableHead>{t("electricity.period")}</TableHead>
                    <TableHead>{t("electricity.previousReading")}</TableHead>
                    <TableHead>{t("electricity.reading")}</TableHead>
                    <TableHead>{t("electricity.consumption")}</TableHead>
                    <TableHead>{t("electricity.readBy")}</TableHead>
                    <TableHead>{t("electricity.readingDate")}</TableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(readings.data?.items ?? []).map((reading, index) => (
                    <TableRow key={reading.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell>{reading.meter?.meter_number ?? "—"}</TableCell>
                      <TableCell>
                        {reading.unit ? `${reading.unit.code} — ${reading.unit.name}` : "—"}
                      </TableCell>
                      <TableCell>
                        {reading.period_month}/{reading.period_year}
                      </TableCell>
                      <TableCell>{formatElectricityNumber(reading.previous_reading)}</TableCell>
                      <TableCell>{formatElectricityNumber(reading.reading)}</TableCell>
                      <TableCell>
                        {formatElectricityNumber(reading.consumption_kwh)} {t("electricity.kwh")}
                      </TableCell>
                      <TableCell>
                        {reading.actor?.display_name ??
                          reading.actor?.username ??
                          reading.actor?.email ??
                          "—"}
                      </TableCell>
                      <TableCell>{reading.reading_date}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            title={t("common.edit")}
                            size="icon"
                            variant="ghost"
                            disabled={!permissions.can(PERMISSIONS.ELECTRICITY_UPDATE)}
                            onClick={() => openForm(reading)}
                          >
                            <Pencil className="size-4" />
                            <span className="sr-only">{t("common.edit")}</span>
                          </Button>
                          <Button
                            title={t("common.delete")}
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            disabled={!permissions.can(PERMISSIONS.ELECTRICITY_DELETE)}
                            onClick={() => setDeleteTarget(reading)}
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
          <Pager page={page} pageSize={10} count={readings.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {target ? t("electricity.readings.edit") : t("electricity.readings.add")}
            </DialogTitle>
            <DialogDescription>{t("electricity.readings.formHelp")}</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={saveReading}>
            <ElectricityField
              required
              label={t("electricity.meter")}
              error={form.formState.errors.meter_id?.message}
            >
              <Select
                value={form.watch("meter_id")}
                onValueChange={(selectedMeterId) =>
                  form.setValue("meter_id", selectedMeterId, { shouldValidate: true })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(meters.data?.items ?? []).map((meter) => (
                    <SelectItem key={meter.id} value={meter.id}>
                      {meter.meter_number ?? t("electricity.meterWithoutNumber")} —{" "}
                      {meter.unit?.code ?? "—"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ElectricityField>
            <ElectricityField
              required
              label={t("electricity.readingDate")}
              error={form.formState.errors.reading_date?.message}
            >
              <DateInput
                value={form.watch("reading_date")}
                onChange={(value) => form.setValue("reading_date", value, { shouldValidate: true })}
              />
            </ElectricityField>
            <ElectricityField
              required
              label={t("electricity.periodYear")}
              error={form.formState.errors.period_year?.message}
            >
              <Input type="number" min="2000" max="2200" {...form.register("period_year")} />
            </ElectricityField>
            <ElectricityField
              required
              label={t("electricity.periodMonth")}
              error={form.formState.errors.period_month?.message}
            >
              <Input type="number" min="1" max="12" {...form.register("period_month")} />
            </ElectricityField>
            <ElectricityField
              required
              label={t("electricity.reading")}
              error={form.formState.errors.reading?.message}
            >
              <Input type="number" min="0" step="0.001" {...form.register("reading")} />
            </ElectricityField>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p>
                {t("electricity.previousReading")}: {formatElectricityNumber(previousValue)}
              </p>
              <p className={consumptionPreview < 0 ? "text-destructive" : "font-medium"}>
                {t("electricity.consumptionPreview")}: {formatElectricityNumber(consumptionPreview)}{" "}
                {t("electricity.kwh")}
              </p>
            </div>
            <div className="sm:col-span-2">
              <ElectricityField label={t("common.notes")}>
                <Textarea {...form.register("note")} />
              </ElectricityField>
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={createReading.isPending || updateReading.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteReading.isPending}
        title={t("electricity.readings.deleteTitle")}
        description={t("electricity.readings.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteReading.mutateAsync(deleteTarget);
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
