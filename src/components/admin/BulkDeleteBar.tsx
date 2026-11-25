import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { useI18n } from "@/i18n/provider";

/**
 * Reusable "N rows selected — delete all" bar for admin list pages.
 * Given a `deleteOne(id)` async function, deletes selected ids in sequence
 * and surfaces success/failure counts.
 */
export function BulkDeleteBar({
  selected,
  clear,
  deleteOne,
  entityLabel,
  disabled,
}: {
  selected: string[];
  clear: () => void;
  deleteOne: (id: string) => Promise<void>;
  entityLabel: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);

  if (selected.length === 0) return null;

  async function runDelete() {
    setPending(true);
    let ok = 0;
    let fail = 0;
    for (const id of selected) {
      try {
        await deleteOne(id);
        ok += 1;
      } catch (error) {
        // The toast reports only a count; keep each reason so "3 failed" is
        // answerable from the console.
        console.error("[bulk-delete] failed:", error);
        fail += 1;
      }
    }
    setPending(false);
    setConfirm(false);
    clear();
    if (fail === 0) toast.success(`${t("phase2.deleted")} (${ok})`);
    else toast.error(`${t("phase2.deleteError")}: ${fail} / ${ok + fail}`);
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm">
        <span className="font-medium">
          {selected.length} {entityLabel}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={clear}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled || pending}
            onClick={() => setConfirm(true)}
          >
            <Trash2 className="me-1 size-4" />
            {t("common.delete")}
          </Button>
        </div>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("phase2.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("phase2.bulkDeleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={runDelete}>
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
