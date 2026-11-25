import { useState } from "react";
import { toast } from "sonner";

import { DeleteConfirmation } from "@/components/admin/Phase2Ui";
import { ElectricityField } from "@/components/admin/electricity/ElectricityUi";
import { Button } from "@/components/ui/button";
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
import { useGenerateElectricityCharges } from "@/hooks/useGenerateElectricityCharges";
import { useI18n } from "@/i18n/provider";

// Module-level, as it was in ChargesTab: the default period is fixed when the
// bundle loads, not re-read on every mount.
const currentDate = new Date();

/** وحدة تُعرض في قائمة اختيار وحدة التوليد. */
interface UnitOption {
  id: string;
  code: string;
  name: string;
}

interface GenerateChargesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  units: UnitOption[];
}

/**
 * حوار توليد رسوم الكهرباء لفترة محددة، يتبعه تأكيد ثانٍ قبل إنشاء أي رسم.
 *
 * Owns the generation period — deliberately separate from the list filter's
 * period in `ChargesTab`. The two used to share one component scope, and only
 * one of them creates money; keeping this one inside the dialog means a filter
 * change can never be what gets generated. The component stays mounted between
 * opens, so the last period chosen is still selected the next time, exactly as
 * before the split.
 */
export function GenerateChargesDialog({ open, onOpenChange, units }: GenerateChargesDialogProps) {
  const { t } = useI18n();
  const generateCharges = useGenerateElectricityCharges();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [year, setYear] = useState(currentDate.getFullYear());
  const [month, setMonth] = useState(currentDate.getMonth() + 1);
  const [unitId, setUnitId] = useState<string>("all");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("electricity.charges.generate")}</DialogTitle>
            <DialogDescription>{t("electricity.charges.generateHelp")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <ElectricityField required label={t("electricity.periodYear")}>
              <Input
                type="number"
                min="2000"
                max="2200"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              />
            </ElectricityField>
            <ElectricityField required label={t("electricity.periodMonth")}>
              <Input
                type="number"
                min="1"
                max="12"
                value={month}
                onChange={(event) => setMonth(Number(event.target.value))}
              />
            </ElectricityField>
            <div className="sm:col-span-2">
              <ElectricityField label={t("electricity.unitOptional")}>
                <Select value={unitId} onValueChange={setUnitId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("common.all")}</SelectItem>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.code} — {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ElectricityField>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={month < 1 || month > 12 || year < 2000 || year > 2200}
              onClick={() => {
                onOpenChange(false);
                setConfirmOpen(true);
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteConfirmation
        open={confirmOpen}
        pending={generateCharges.isPending}
        title={t("electricity.charges.generateConfirmTitle")}
        description={t("electricity.charges.generateConfirm")}
        close={() => setConfirmOpen(false)}
        confirm={async () => {
          try {
            const generated = await generateCharges.mutateAsync({
              periodMonth: month,
              periodYear: year,
              unitId: unitId === "all" ? null : unitId,
            });
            setConfirmOpen(false);
            toast.success(`${t("electricity.charges.generated")}: ${generated.length}`);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : t("common.error"));
          }
        }}
      />
    </>
  );
}
