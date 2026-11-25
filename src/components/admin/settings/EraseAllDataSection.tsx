import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import { eraseAllData } from "@/fns/eraseAllData";
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

/**
 * يعرض منطقة الخطر (مسح كل البيانات) مع نافذة التأكيد التي تشترط كتابة RESET.
 *
 * The card is admin-only; the dialog is always mounted, exactly as it was when
 * this lived inline in the company settings page.
 */
export function EraseAllDataSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  async function handleResetDatabase() {
    setIsResetting(true);
    try {
      await eraseAllData();
      toast.success(t("settingsHub.databaseResetSuccessfully"));
      setIsResetOpen(false);
      setResetConfirmText("");
    } catch (error) {
      toast.error(t("settingsHub.failedToResetDatabase"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <>
      {isAdmin && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">{t("settingsHub.dangerZone")}</CardTitle>
            <CardDescription>{t("settingsHub.destructiveActionsThatCannotBe")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-semibold text-sm">{t("settingsHub.eraseAllDatabaseData")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settingsHub.deleteAllContractsTenantsInvoices")}
                </p>
              </div>
              <Button variant="destructive" onClick={() => setIsResetOpen(true)}>
                {t("settingsHub.eraseAllData")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={isResetOpen} onOpenChange={setIsResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive text-left">
              {t("settingsHub.areYouAbsolutelySure")}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left space-y-2">
              <span>{t("settingsHub.thisActionWillPermanentlyDelete")}</span>
              <br />
              <span className="block font-medium text-foreground mt-2">
                {t("settingsHub.pleaseTypeResetToConfirm")}
              </span>
              <Input
                type="text"
                placeholder="RESET"
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                className="mt-2"
                dir="ltr"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting} onClick={() => setResetConfirmText("")}>
              {t("settingsHub.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleResetDatabase();
              }}
              disabled={resetConfirmText !== "RESET" || isResetting}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {isResetting ? t("settingsHub.erasing") : t("settingsHub.yesEraseEverything")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
