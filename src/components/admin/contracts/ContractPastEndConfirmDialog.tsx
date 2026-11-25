import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import type { ContractFormValues } from "@/lib/contractForm";
import { resolveUnitCode } from "@/lib/contractLifecycle";
import { joinLocalizedList } from "@/lib/contractUnits";

type ContractPastEndConfirmDialogProps = {
  /** The parked submission; null keeps the dialog closed. */
  values: ContractFormValues | null;
  units: ReadonlyArray<{ id: string; code: string | null }>;
  pending: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
};

/**
 * يطلب تأكيد حفظ عقد انتهى تاريخه بحالة «منتهٍ» بدلاً من «نشط».
 *
 * Mounted beside the form dialog rather than inside its `DialogContent`, the
 * placement `dialog.test.tsx` enforces for dialogs across the app.
 */
export function ContractPastEndConfirmDialog({
  values,
  units,
  pending,
  onDismiss,
  onConfirm,
}: ContractPastEndConfirmDialogProps) {
  const { t, locale } = useI18n();
  const unitCodes = values
    ? values.units
        .map((row) => resolveUnitCode(row.unit_id, units))
        .filter((code): code is string => Boolean(code))
    : [];
  const description = (() => {
    if (!values) return null;
    if (!unitCodes.length) return t("contracts.pastEndConfirmDescriptionNoUnit");
    const template = t("contracts.pastEndConfirmDescription");
    const marker = "{unit}";
    const at = template.indexOf(marker);
    if (at < 0) return template;
    return (
      <>
        {template.slice(0, at)}
        <LtrText>{joinLocalizedList(unitCodes, locale)}</LtrText>
        {template.slice(at + marker.length)}
      </>
    );
  })();

  return (
    <AlertDialog
      open={Boolean(values)}
      onOpenChange={(openDialog) => {
        if (!openDialog) onDismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("contracts.pastEndConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
