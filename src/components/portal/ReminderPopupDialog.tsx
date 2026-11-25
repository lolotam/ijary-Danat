import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useI18n } from "@/i18n/provider";

/**
 * يقرأ حالة الإغلاق من sessionStorage؛ أي خطأ يعني «لم تُغلق» فتظهر النافذة.
 *
 * A throwing store is treated as not-dismissed so a locked-down browser cannot
 * silently suppress the reminder the office still wants shown.
 */
function readDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * يحفظ إغلاق النافذة في sessionStorage لهذا التبويب وهذا المستأجر.
 *
 * Tab-scoped on purpose: a second tab should still see the reminder, and a
 * different login in this tab uses a different key.
 */
function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(key, "1");
  } catch {
    // A throwing store leaves the in-memory dismissed flag as the only record.
  }
}

/**
 * نافذة تذكير حمراء تظهر مرة لكل تبويب متصفح لكل مستأجر، ما لم يُخفِها المسؤول.
 *
 * Fails closed: nothing renders until the flag read succeeded (`isReady`), so
 * a network error can never surface a popup the office switched off.
 * sessionStorage is tab-scoped and survives reloads; the tenant id in the key
 * keeps one login's dismissal from hiding it for the next. A throwing store
 * means "not dismissed".
 */
export function ReminderPopupDialog({ tenantId }: { tenantId: string }) {
  return <TenantReminderPopup key={tenantId} tenantId={tenantId} />;
}

/** يعزل حالة الإغلاق لكل مستأجر حتى عند تبديل الهوية دون فك تركيب البوابة. */
function TenantReminderPopup({ tenantId }: { tenantId: string }) {
  const { t } = useI18n();
  const { isCardVisible, isReady } = useCardVisibility();
  const key = `portal.reminderPopup.dismissed:${tenantId}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  if (!isReady || dismissed || !isCardVisible("portal.reminderPopup")) return null;

  /**
   * يغلق النافذة ويثبّت الإغلاق في تخزين الجلسة لهذا المستأجر.
   */
  const dismiss = () => {
    writeDismissed(key);
    setDismissed(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="border-2 border-red-600 bg-red-50 text-red-900 dark:bg-red-950/70 dark:text-red-100 animate-fade-in motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-6 animate-pulse text-red-600 motion-reduce:animate-none" />
            {t("portal.reminder.title")}
          </DialogTitle>
          <DialogDescription className="text-base font-semibold leading-relaxed text-red-900 dark:text-red-100">
            {t("portal.reminder.body")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button className="bg-red-600 hover:bg-red-700" onClick={dismiss}>
            {t("portal.reminder.understood")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
