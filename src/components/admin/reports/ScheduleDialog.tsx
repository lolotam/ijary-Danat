import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCreateReportSchedule, useUpdateReportSchedule } from "@/hooks/useReportSchedules";
import { useI18n } from "@/i18n/provider";
import type {
  LocaleCode,
  ReportFrequency,
  ReportKind,
  Tables,
} from "@/integrations/supabase/database.types";

const frequencies: ReportFrequency[] = ["daily", "weekly", "monthly", "yearly"];
const reportKinds: ReportKind[] = ["summary", "overdue_contracts"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ScheduleDraft {
  code: string;
  frequency: ReportFrequency;
  isActive: boolean;
  locale: LocaleCode;
  nameAr: string;
  nameEn: string;
  recipients: string;
  reportKind: ReportKind;
}

const emptySchedule: ScheduleDraft = {
  code: "",
  frequency: "monthly",
  isActive: true,
  locale: "ar",
  nameAr: "",
  nameEn: "",
  recipients: "",
  reportKind: "summary",
};

/** يحوّل صف جدولة محفوظاً إلى مسودة قابلة للتحرير، أو مسودة فارغة للإضافة. */
function draftFrom(schedule: Tables<"report_schedules"> | null): ScheduleDraft {
  if (!schedule) return emptySchedule;
  return {
    code: schedule.code,
    frequency: schedule.frequency,
    isActive: schedule.is_active,
    locale: schedule.locale,
    nameAr: schedule.name_ar,
    nameEn: schedule.name_en ?? "",
    recipients: Array.isArray(schedule.recipients) ? schedule.recipients.join(", ") : "",
    reportKind: schedule.report_kind,
  };
}

/** يفكّ قائمة المستلمين المفصولة بفواصل إلى عناوين مشذّبة غير فارغة. */
function splitRecipients(recipients: string): string[] {
  return recipients
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** الجدولة المحرَّرة، أو null لإضافة جديدة. */
  target: Tables<"report_schedules"> | null;
}

/**
 * حوار إضافة جدولة تقرير أو تعديلها، مع إدارة قائمة المستلمين.
 *
 * The draft is seeded from `target` once, at mount. The parent remounts this
 * dialog (a fresh `key`) every time it is opened, which is what guarantees an
 * "Add" never inherits the values of the schedule edited just before it.
 */
export function ScheduleDialog({ open, onOpenChange, target }: ScheduleDialogProps) {
  const { t } = useI18n();
  const createSchedule = useCreateReportSchedule();
  const updateSchedule = useUpdateReportSchedule();
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFrom(target));
  const [extraEmailInput, setExtraEmailInput] = useState("");

  const addExtraEmail = (emailToAdd?: string) => {
    const candidate = (emailToAdd ?? extraEmailInput).trim();
    if (!candidate) return;
    if (!EMAIL_PATTERN.test(candidate)) {
      toast.error(t("common.error"));
      return;
    }
    const currentList = splitRecipients(draft.recipients);
    if (!currentList.includes(candidate)) {
      const updated = [...currentList, candidate].join(", ");
      setDraft((current) => ({ ...current, recipients: updated }));
    }
    setExtraEmailInput("");
  };

  const removeEmail = (emailToRemove: string) => {
    const updated = splitRecipients(draft.recipients)
      .filter((item) => item !== emailToRemove)
      .join(", ");
    setDraft((current) => ({ ...current, recipients: updated }));
  };

  /**
   * يحفظ الجدولة الجديدة أو المعدّلة مع نوع التقرير.
   *
   * Create and update share one payload so a schedule cannot be saved
   * without the kind the runner later branches on.
   */
  const save = async () => {
    const recipients = splitRecipients(draft.recipients);
    if (!recipients.every((email) => EMAIL_PATTERN.test(email))) {
      toast.error(t("common.error"));
      return;
    }
    const values = {
      code: draft.code,
      name_ar: draft.nameAr,
      name_en: draft.nameEn || null,
      frequency: draft.frequency,
      recipients,
      locale: draft.locale,
      is_active: draft.isActive,
      report_kind: draft.reportKind,
    };
    try {
      if (target) await updateSchedule.mutateAsync({ id: target.id, updates: values });
      else await createSchedule.mutateAsync(values);
      toast.success(t("common.saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? t("reports.editSchedule") : t("reports.addSchedule")}</DialogTitle>
          <DialogDescription>{t("reports.recipientsHelp")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("reports.code")}</Label>
            <Input
              dir="ltr"
              value={draft.code}
              onChange={(event) =>
                setDraft((current) => ({ ...current, code: event.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t("reports.frequency")}</Label>
            <Select
              value={draft.frequency}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, frequency: value as ReportFrequency }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {frequencies.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`reportFrequency.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("reports.reportKind")}</Label>
            <Select
              value={draft.reportKind}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, reportKind: value as ReportKind }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {reportKinds.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`reports.reportKind.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("common.nameAr")}</Label>
            <Input
              value={draft.nameAr}
              onChange={(event) =>
                setDraft((current) => ({ ...current, nameAr: event.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t("common.nameEn")}</Label>
            <Input
              dir="ltr"
              value={draft.nameEn}
              onChange={(event) =>
                setDraft((current) => ({ ...current, nameEn: event.target.value }))
              }
            />
          </div>
          <div className="space-y-3 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>{t("reports.recipients")}</Label>
              <span className="text-xs text-muted-foreground">{t("reports.recipientsHelp")}</span>
            </div>

            {draft.recipients.trim() ? (
              <div className="flex flex-wrap gap-1.5 rounded-lg border bg-muted/20 p-2.5">
                {splitRecipients(draft.recipients).map((email) => (
                  <Badge
                    key={email}
                    variant="secondary"
                    className="gap-1 px-2.5 py-1 font-mono text-xs shadow-xs"
                  >
                    {email}
                    <button
                      type="button"
                      className="ms-1 rounded-full text-muted-foreground transition-colors hover:text-destructive"
                      onClick={() => removeEmail(email)}
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="flex gap-2">
              <Input
                dir="ltr"
                placeholder="extra.recipient@company.com"
                value={extraEmailInput}
                onChange={(e) => setExtraEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExtraEmail();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => addExtraEmail()}
                disabled={!extraEmailInput.trim()}
              >
                <Plus className="size-4 me-1" />
                {t("reports.addSchedule") ? "إضافة إيميل" : "Add Email"}
              </Button>
            </div>

            <Input
              dir="ltr"
              value={draft.recipients}
              onChange={(event) =>
                setDraft((current) => ({ ...current, recipients: event.target.value }))
              }
              placeholder="admin1@company.com, admin2@company.com"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("reports.locale")}</Label>
            <Select
              value={draft.locale}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, locale: value as LocaleCode }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">{t("localeName.ar")}</SelectItem>
                <SelectItem value="en">{t("localeName.en")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-between rounded-md border p-3">
            <Label>{t("reports.active")}</Label>
            <Switch
              checked={draft.isActive}
              onCheckedChange={(checked) =>
                setDraft((current) => ({ ...current, isActive: checked }))
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !draft.code.trim() ||
              !draft.nameAr.trim() ||
              !draft.recipients.trim() ||
              createSchedule.isPending ||
              updateSchedule.isPending
            }
            onClick={save}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
