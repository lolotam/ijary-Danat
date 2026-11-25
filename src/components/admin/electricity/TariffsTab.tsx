import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { DeleteConfirmation, Pager, TableState } from "@/components/admin/Phase2Ui";
import { ActiveBadge, ElectricityField } from "@/components/admin/electricity/ElectricityUi";
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
  useCreateElectricityTariff,
  useDeleteElectricityTariff,
  useElectricityTariffs,
  useUpdateElectricityTariff,
  type ElectricityTariff,
} from "@/hooks/useElectricityTariffs";
import { usePermissions } from "@/hooks/usePermissions";
import { useDebounce } from "@/hooks/useDebounce";
import { useI18n } from "@/i18n/provider";
import type { Json, TariffType } from "@/integrations/supabase/database.types";
import { formatElectricityRate } from "@/lib/electricity";
import { PERMISSIONS } from "@/lib/permissions";

const tariffTypes = ["flat", "tiered", "per_unit"] as const;

const tariffSchema = z.object({
  code: z.string().trim().min(1),
  currency: z.string().trim().min(1),
  is_active: z.boolean(),
  name_ar: z.string().trim().min(1),
  name_en: z.string(),
  tiers: z.string(),
  type: z.enum(tariffTypes),
  unit_price: z.coerce.number().finite().nonnegative(),
});

const tierSchema = z
  .array(
    z.object({
      from_kwh: z.number().finite().nonnegative(),
      price_per_kwh: z.number().finite().nonnegative(),
      to_kwh: z.number().finite().positive().nullable(),
    }),
  )
  .min(1);

type TariffForm = z.infer<typeof tariffSchema>;
type TariffTier = z.infer<typeof tierSchema>[number];

const emptyTariff = (): TariffForm => ({
  code: "",
  currency: "KWD",
  is_active: true,
  name_ar: "",
  name_en: "",
  tiers: '[{"from_kwh":0,"to_kwh":null,"price_per_kwh":0}]',
  type: "per_unit",
  unit_price: 0,
});

function tiersAreContiguous(tiers: TariffTier[]) {
  let nextBoundary = 0;
  let openEnded = false;
  for (const tier of tiers) {
    if (openEnded || tier.from_kwh !== nextBoundary) return false;
    if (tier.to_kwh !== null && tier.to_kwh <= tier.from_kwh) return false;
    if (tier.to_kwh === null) openEnded = true;
    else nextBoundary = tier.to_kwh;
  }
  return true;
}

function parsedTiers(tiersJson: string): Json | null {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(tiersJson);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const validatedTiers = tierSchema.safeParse(parsedJson);
  if (!validatedTiers.success || !tiersAreContiguous(validatedTiers.data)) return null;
  return validatedTiers.data as Json;
}

export function TariffsTab() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);
  const tariffs = useElectricityTariffs({ page, pageSize: 10, search: debouncedSearch });
  const createTariff = useCreateElectricityTariff();
  const updateTariff = useUpdateElectricityTariff();
  const deleteTariff = useDeleteElectricityTariff();
  const [formOpen, setFormOpen] = useState(false);
  const [target, setTarget] = useState<ElectricityTariff | null>(null);
  /**
   * معرّف التعرفة التي أنشأها هذا النموذج، ليصبح الحفظ التالي تعديلًا لا إضافة.
   *
   * The form no longer closes on save, so a second Save would otherwise add a
   * duplicate tariff.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ElectricityTariff | null>(null);
  const form = useForm<TariffForm>({
    resolver: zodResolver(tariffSchema),
    defaultValues: emptyTariff(),
  });

  if (!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  const openForm = (tariff?: ElectricityTariff) => {
    setCreatedId(null);
    setTarget(tariff ?? null);
    form.reset(
      tariff
        ? {
            code: tariff.code,
            currency: tariff.currency,
            is_active: tariff.is_active,
            name_ar: tariff.name_ar,
            name_en: tariff.name_en ?? "",
            tiers: tariff.tiers ? JSON.stringify(tariff.tiers) : emptyTariff().tiers,
            type: tariff.type,
            unit_price: tariff.unit_price,
          }
        : emptyTariff(),
    );
    setFormOpen(true);
  };

  const saveTariff = form.handleSubmit(async (tariffForm) => {
    const tiers = tariffForm.type === "tiered" ? parsedTiers(tariffForm.tiers) : null;
    if (tariffForm.type === "tiered" && !tiers) {
      toast.error(t("electricity.tariffs.invalidTiers"));
      return;
    }
    const payload = {
      code: tariffForm.code,
      currency: tariffForm.currency,
      is_active: tariffForm.is_active,
      name_ar: tariffForm.name_ar,
      name_en: tariffForm.name_en.trim() || null,
      tiers,
      type: tariffForm.type,
      unit_price: tariffForm.unit_price,
    };
    // Coalesced before the branch: the form stays open after a create and
    // `target` is still null then, so the next Save must update the row this
    // one inserted.
    const editingId = target?.id ?? createdId;
    try {
      if (editingId) await updateTariff.mutateAsync({ id: editingId, updates: payload });
      else {
        const created = await createTariff.mutateAsync(payload);
        setCreatedId(created.id);
      }
      form.reset(tariffForm);
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
          disabled={!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)}
          onClick={() => openForm()}
        >
          <Plus className="size-4" />
          {t("electricity.tariffs.add")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <TableState
            loading={tariffs.isLoading}
            error={tariffs.isError}
            empty={!tariffs.data?.items.length}
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{t("common.code")}</TableHead>
                    <TableHead>{t("common.nameAr")}</TableHead>
                    <TableHead>{t("common.nameEn")}</TableHead>
                    <TableHead>{t("electricity.tariffType")}</TableHead>
                    <TableHead>{t("electricity.unitPrice")}</TableHead>
                    <TableHead>{t("common.status")}</TableHead>
                    <TableHead>{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(tariffs.data?.items ?? []).map((tariff, index) => (
                    <TableRow key={tariff.id}>
                      <TableCell>{(page - 1) * 10 + index + 1}</TableCell>
                      <TableCell className="font-mono">{tariff.code}</TableCell>
                      <TableCell>{tariff.name_ar}</TableCell>
                      <TableCell>{tariff.name_en ?? "—"}</TableCell>
                      <TableCell>{t(`electricity.tariffType.${tariff.type}`)}</TableCell>
                      <TableCell>
                        {formatElectricityRate(tariff.unit_price, tariff.currency)}
                      </TableCell>
                      <TableCell>
                        <ActiveBadge active={tariff.is_active} />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            title={t("common.edit")}
                            size="icon"
                            variant="ghost"
                            disabled={!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)}
                            onClick={() => openForm(tariff)}
                          >
                            <Pencil className="size-4" />
                            <span className="sr-only">{t("common.edit")}</span>
                          </Button>
                          <Button
                            title={t("common.delete")}
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            disabled={!permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS)}
                            onClick={() => setDeleteTarget(tariff)}
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
          <Pager page={page} pageSize={10} count={tariffs.data?.count ?? 0} setPage={setPage} />
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {target ? t("electricity.tariffs.edit") : t("electricity.tariffs.add")}
            </DialogTitle>
            <DialogDescription>{t("electricity.tariffs.formHelp")}</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={saveTariff}>
            <ElectricityField
              required
              label={t("common.code")}
              error={form.formState.errors.code?.message}
            >
              <Input dir="ltr" {...form.register("code")} />
            </ElectricityField>
            <ElectricityField required label={t("electricity.tariffType")}>
              <Select
                value={form.watch("type")}
                onValueChange={(tariffType) => form.setValue("type", tariffType as TariffType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tariffTypes.map((tariffType) => (
                    <SelectItem key={tariffType} value={tariffType}>
                      {t(`electricity.tariffType.${tariffType}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ElectricityField>
            <ElectricityField
              required
              label={t("common.nameAr")}
              error={form.formState.errors.name_ar?.message}
            >
              <Input {...form.register("name_ar")} />
            </ElectricityField>
            <ElectricityField label={t("common.nameEn")}>
              <Input dir="ltr" {...form.register("name_en")} />
            </ElectricityField>
            <ElectricityField
              required
              label={t("electricity.unitPrice")}
              error={form.formState.errors.unit_price?.message}
            >
              <Input type="number" min="0" step="0.001" {...form.register("unit_price")} />
            </ElectricityField>
            <ElectricityField required label={t("electricity.currency")}>
              <Input dir="ltr" {...form.register("currency")} />
            </ElectricityField>
            {form.watch("type") === "tiered" && (
              <div className="sm:col-span-2">
                <ElectricityField label={t("electricity.tariffs.tiers")}>
                  <Textarea
                    className="min-h-32 font-mono text-xs"
                    dir="ltr"
                    {...form.register("tiers")}
                  />
                </ElectricityField>
              </div>
            )}
            <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
              <span className="text-sm font-medium">{t("electricity.active")}</span>
              <Switch
                checked={form.watch("is_active")}
                onCheckedChange={(checked) => form.setValue("is_active", checked)}
              />
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={createTariff.isPending || updateTariff.isPending}>
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmation
        open={Boolean(deleteTarget)}
        pending={deleteTariff.isPending}
        title={t("electricity.tariffs.deleteTitle")}
        description={t("electricity.tariffs.deleteConfirm")}
        close={() => setDeleteTarget(null)}
        confirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteTariff.mutateAsync(deleteTarget);
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
