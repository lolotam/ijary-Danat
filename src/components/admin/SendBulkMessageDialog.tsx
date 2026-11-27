import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { MessagePreviewPanel } from "@/components/admin/MessagePreviewPanel";
import { TemplateOptionLabel } from "@/components/admin/TemplateOptionLabel";
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
import { Textarea } from "@/components/ui/textarea";
import { useSendBulkNotification } from "@/hooks/useSendBulkNotification";
import { useTenantEligibleTemplates } from "@/hooks/useTenantEligibleTemplates";
import { useTenants } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import type { LocaleCode, NotificationChannel } from "@/integrations/supabase/database.types";

const channels: NotificationChannel[] = ["email", "whatsapp", "both"];

type BulkAudience = "all" | "with_active_contract" | "selected";

interface SendBulkMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * يستبدل {count} في نص الترجمة بعدد المستلمين.
 */
function withCount(template: string, count: number): string {
  return template.replaceAll("{count}", String(count));
}

/**
 * حوار إرسال رسالة جماعية للمستأجرين مع تأكيد كتابي للعدد ومعاينة عيّنة.
 *
 * Bulk messaging is irreversible and outward-facing; Send stays disabled until
 * the admin types the recipient count. Preview is against the first matching
 * tenant and labelled as a sample.
 */
export function SendBulkMessageDialog({ open, onOpenChange }: SendBulkMessageDialogProps) {
  const { t } = useI18n();
  const [audience, setAudience] = useState<BulkAudience>("all");
  const [channel, setChannel] = useState<NotificationChannel>("email");
  const [locale, setLocale] = useState<LocaleCode>("ar");
  const [templateCode, setTemplateCode] = useState("free");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [respectReminders, setRespectReminders] = useState(true);
  const [confirmText, setConfirmText] = useState("");

  const tenants = useTenants({ pageSize: 500 }, open);
  const eligible = useTenantEligibleTemplates(channel);
  const sendBulk = useSendBulkNotification();

  useEffect(() => {
    if (templateCode === "free") return;
    if (eligible.data.some((template) => template.code === templateCode)) return;
    setTemplateCode("free");
  }, [eligible.data, templateCode]);

  /**
   * يجمع المستأجرين المطابقين مع عدد المستأجرين المستبعدين بسبب إيقاف إشعاراتهم.
   *
   * The paused count is surfaced to the admin instead of being silently
   * dropped: a bare "Recipients: 0" reads as a bug, while "0 recipients · 3
   * excluded: notifications paused" points at the tenant records to un-pause.
   */
  const matchingTenants = useMemo(() => {
    const items = tenants.data?.items ?? [];
    let list = items;
    if (audience === "with_active_contract") {
      // Tenant list already carries hasOverdue / locations; "active contract"
      // is approximated by having a connected property (active location).
      list = items.filter(
        (tenant) =>
          Boolean(tenant.connectedProperty) ||
          (tenant.activeContracts && tenant.activeContracts.length > 0),
      );
    }
    // The server skips paused tenants too, so the confirmed count matches what is queued.
    const pausedCount = list.filter((tenant) => tenant.notifications_paused).length;
    list = list.filter((tenant) => !tenant.notifications_paused);
    if (respectReminders) {
      list = list.filter((tenant) => tenant.reminders_enabled);
    }
    // Channel address filter for the live count (server still re-checks).
    if (channel === "email") {
      list = list.filter((tenant) => Boolean(tenant.email?.trim()));
    } else if (channel === "whatsapp") {
      list = list.filter((tenant) => Boolean((tenant.whatsapp ?? tenant.mobile)?.trim()));
    } else {
      list = list.filter(
        (tenant) =>
          Boolean(tenant.email?.trim()) || Boolean((tenant.whatsapp ?? tenant.mobile)?.trim()),
      );
    }
    return { list, pausedCount };
  }, [tenants.data?.items, audience, respectReminders, channel]);

  const recipientCount = matchingTenants.list.length;
  const sampleTenantId = matchingTenants.list[0]?.id ?? null;
  const confirmOk = confirmText.trim() === String(recipientCount) && recipientCount > 0;

  useEffect(() => {
    if (!open) {
      setConfirmText("");
      setTemplateCode("free");
      setSubject("");
      setBody("");
      setRespectReminders(true);
      setAudience("all");
    }
  }, [open]);

  /**
   * يترجم سبب تخطّي المستأجر إلى نصّ يقرأه المسؤول.
   *
   * A raw reason string is developer-facing ("reminders_disabled"), and the one
   * the admin most needs to act on — the tenant's own notifications are paused —
   * reads as a fault when left as a token. Every other reason stays as it is.
   */
  function skipReasonText(reason: string): string {
    if (reason === "notifications_paused") return t("notifications.bulkSkipTenantPaused");
    return reason;
  }

  /**
   * يرسل الدفعة بعد التأكد من العدد المكتوب.
   */
  const submit = async () => {
    if (!confirmOk) return;
    try {
      const result = await sendBulk.mutateAsync({
        audience,
        channel,
        locale,
        templateCode: templateCode === "free" ? null : templateCode,
        subject: subject || null,
        body: body || null,
        respectRemindersEnabled: respectReminders,
      });
      // The send itself is the worker's; this reports the staging step and its
      // skips. The outcome arrives later as the requester's notice.
      toast.success(
        `${t("notifications.bulkQueued").replaceAll("{queued}", String(result.staged))} · ${t("notifications.bulkSkipped").replaceAll("{skipped}", String(result.skipped.length))}`,
      );
      if (result.skipped.length) {
        const reasons = result.skipped
          .slice(0, 8)
          .map((row) => `${row.tenantId.slice(0, 8)}…: ${skipReasonText(row.reason)}`)
          .join("; ");
        toast.message(reasons);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("notifications.sendBulk")}</DialogTitle>
          <DialogDescription>
            {withCount(t("notifications.bulkRecipientCount"), recipientCount)}
            {matchingTenants.pausedCount > 0 ? (
              <>
                {" · "}
                {withCount(t("notifications.bulkPausedExcluded"), matchingTenants.pausedCount)}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="space-y-2">
            <Label>{t("notifications.bulkAudience")}</Label>
            <Select value={audience} onValueChange={(value) => setAudience(value as BulkAudience)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("notifications.bulkAudienceAll")}</SelectItem>
                <SelectItem value="with_active_contract">
                  {t("notifications.bulkAudienceActive")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("notifications.channel")}</Label>
            <Select
              value={channel}
              onValueChange={(value) => setChannel(value as NotificationChannel)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channels.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`notificationChannel.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("notifications.manualLocale")}</Label>
            <Select value={locale} onValueChange={(value) => setLocale(value as LocaleCode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ar">AR — العربية</SelectItem>
                <SelectItem value="en">EN — English</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("notifications.template")}</Label>
            <Select value={templateCode} onValueChange={setTemplateCode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">{t("notifications.freeText")}</SelectItem>
                {eligible.data.map((template) => (
                  <SelectItem key={template.id} value={template.code}>
                    <TemplateOptionLabel
                      code={template.code}
                      type={template.type}
                      locale={locale}
                    />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {sampleTenantId && templateCode !== "free" ? (
            <MessagePreviewPanel
              tenantId={sampleTenantId}
              templateCode={templateCode}
              contractId={null}
              channel={channel}
              sampleNotice
            />
          ) : null}

          {templateCode === "free" ? (
            <>
              <div className="space-y-2">
                <Label>{t("notifications.subject")}</Label>
                <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t("notifications.body")}</Label>
                <Textarea rows={5} value={body} onChange={(event) => setBody(event.target.value)} />
              </div>
            </>
          ) : null}

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <Label htmlFor="bulk-respect-reminders">
              {t("notifications.bulkRespectReminders")}
            </Label>
            <Switch
              id="bulk-respect-reminders"
              checked={respectReminders}
              onCheckedChange={setRespectReminders}
            />
          </div>

          <div className="space-y-2">
            <Label required>{withCount(t("notifications.bulkConfirm"), recipientCount)}</Label>
            <Input
              inputMode="numeric"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={String(recipientCount || "")}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !confirmOk ||
              sendBulk.isPending ||
              (templateCode === "free" && !body.trim()) ||
              recipientCount === 0
            }
            onClick={submit}
          >
            {t("notifications.sendBulk")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
