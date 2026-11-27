import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import type { CompanyStatus } from "@/integrations/supabase/database.types";
import { platformErrorMessage, setPlatformCompanyStatus } from "@/platform/platformFns";

/** ما يعرضه زر تغيير حالة الشركة. */
export interface CompanyStatusControlProps {
  companyId: string;
  status: CompanyStatus;
  /** يُستدعى بعد نجاح التغيير، ليجدّد المشرف العام حالة الشركة. */
  onStatusChanged: (status: CompanyStatus) => void;
}

/** أقل طول للسبب، كما تقبله العملية. */
const MIN_REASON_LENGTH = 3;

/** أقصى طول للسبب، كما تقبله العملية. */
const MAX_REASON_LENGTH = 500;

/**
 * زر إيقاف الشركة أو إعادة تفعيلها، مع سبب إلزامي في الاتجاهين.
 *
 * The reason is asked for in both directions: suspending is the owner's own
 * decision and reactivation is a decision too, and the decision is what the
 * audit log and the company itself will read later.
 */
export function CompanyStatusControl({
  companyId,
  status,
  onStatusChanged,
}: CompanyStatusControlProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nextStatus: CompanyStatus = status === "active" ? "suspended" : "active";

  /** يمسح ما كُتب في النافذة قبل إغلاقها. */
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setReason("");
      setError(null);
    }
  }

  /**
   * ينفّذ القرار المكتوب في النافذة، ويحدّث حالة الشركة عند نجاحه.
   */
  async function handleConfirm() {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setError(t("platformCompaniesUi.status.reasonInvalid"));
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await setPlatformCompanyStatus({
        companyId,
        status: nextStatus,
        reason: trimmed,
      });
      onStatusChanged(result.status);
      handleOpenChange(false);
    } catch (cause) {
      setError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant={status === "active" ? "destructive" : "outline"}>
          {status === "active"
            ? t("platformCompaniesUi.status.suspend")
            : t("platformCompaniesUi.status.activate")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {nextStatus === "suspended"
              ? t("platformCompaniesUi.status.suspendTitle")
              : t("platformCompaniesUi.status.activateTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {nextStatus === "suspended"
              ? t("platformCompaniesUi.status.suspendBody")
              : t("platformCompaniesUi.status.activateBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="platform-company-status-reason" required>
            {t("platformCompaniesUi.status.reason")}
          </Label>
          <Textarea
            id="platform-company-status-reason"
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("platformCompaniesUi.status.reasonHint")}
          </p>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline">{t("common.cancel")}</Button>
          </AlertDialogCancel>
          <Button onClick={() => void handleConfirm()} disabled={busy}>
            {busy ? t("platformCompaniesUi.status.busy") : t("platformCompaniesUi.status.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
