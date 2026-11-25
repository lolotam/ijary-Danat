import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

export interface RenameValueDialogProps {
  open: boolean;
  oldValue: string;
  newValue: string;
  /** أعداد السجلات لكل عمود من عدّاد الاستخدام، أو null أثناء الجلب. */
  counts: Record<string, number> | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * يعرض نتيجة إعادة تسمية قيمة عنصر قائمة قبل تنفيذها ويؤكدها.
 *
 * Rows whose count is zero are hidden; an unknown column key falls back to the
 * raw key via `t()`. The confirm button is a plain `Button`, not
 * `AlertDialogAction`, so the dialog stays open while the rename runs (same
 * pattern as RestoreDialog). It closes once the rename commits — the label save
 * that follows reports its own outcome and keeps the edit row open on failure.
 */
export function RenameValueDialog({
  open,
  oldValue,
  newValue,
  counts,
  pending,
  onConfirm,
  onCancel,
}: RenameValueDialogProps) {
  const { t } = useI18n();
  const usedCounts = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("lists.renameValueTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("lists.renameValueConfirm").replace("{old}", oldValue).replace("{new}", newValue)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="text-sm">
          {usedCounts.length > 0 ? (
            <ul className="space-y-1">
              {usedCounts.map(([key, n]) => (
                <li key={key} className="flex justify-between gap-4 border-b pb-1 last:border-none">
                  <span>{t(`lists.renameValueTable.${key}`)}</span>
                  <span className="font-mono">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{t("lists.renameValueNoRecords")}</p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} onClick={onCancel}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <Button onClick={onConfirm} disabled={pending}>
            {t("common.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
