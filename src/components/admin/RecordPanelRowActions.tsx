import { Pencil, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

/**
 * أزرار تعديل وحذف صف سجل مالي.
 *
 * Editing a settled partial payment is allowed (D3′). `locked` remains for
 * callers that still need to freeze a row; the partial-payments table no
 * longer passes it.
 *
 * Deleting stays available even when locked. Since migration 160 a partial
 * payment that settles an invoice in full drives that invoice to `paid`.
 * Deleting it is the supported way to reverse a settlement whose payment
 * refuses reversal.
 *
 * Delete asks first. Every row this component serves — a refund, a partial
 * payment, an insurance payment — is a money record, and since migration 160 a
 * partial payment linked to an invoice also owns a real payment and allocation,
 * so deleting one moves money back. The button used to fire on a single click
 * with nothing in between.
 *
 * A Radix dialog rather than `window.confirm`: a native confirm blocks the event
 * loop, which freezes browser automation against this screen outright.
 */
export function RecordPanelRowActions({
  locked,
  canUpdate,
  canDelete,
  isMobile,
  onEdit,
  onDelete,
  deleteWarning,
}: {
  locked: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  isMobile: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Consequence of deleting this specific row, when it has one beyond removal. */
  deleteWarning?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      {canUpdate && (
        <Button
          variant="ghost"
          size={isMobile ? "sm" : "icon"}
          aria-label={t("common.edit")}
          title={t("common.edit")}
          disabled={locked}
          onClick={onEdit}
        >
          <Pencil className="size-4" />
          {isMobile ? t("common.edit") : null}
        </Button>
      )}
      {canDelete && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size={isMobile ? "sm" : "icon"}
              className="text-destructive"
              aria-label={t("common.delete")}
              title={t("common.delete")}
            >
              <Trash2 className="size-4" />
              {isMobile ? t("common.delete") : null}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("common.confirmDeleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("common.confirmDeleteBody")}
                {deleteWarning ? ` ${deleteWarning}` : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={onDelete}
              >
                {t("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
