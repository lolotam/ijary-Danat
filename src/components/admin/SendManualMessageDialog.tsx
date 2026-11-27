import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { MessagePreviewPanel } from "@/components/admin/MessagePreviewPanel";
import { insertAtCursor, VariableChips } from "@/components/admin/VariableChips";
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
import { Textarea } from "@/components/ui/textarea";
import { TemplateOptionLabel } from "@/components/admin/TemplateOptionLabel";
import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { sendCompanyInfo } from "@/fns/sendCompanyInfo";
import { useMessageVariables } from "@/hooks/useMessageVariables";
import { useSendManualNotification } from "@/hooks/useSendManualNotification";
import { useTenantEligibleTemplates } from "@/hooks/useTenantEligibleTemplates";
import { useTenant, useTenants } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import type { LocaleCode, NotificationChannel } from "@/integrations/supabase/database.types";
import { isContractEnded } from "@/lib/tenantDisplayName";

const channels: NotificationChannel[] = ["email", "whatsapp", "both"];

interface SendManualMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When set, the tenant selector is hidden and this tenant is used
   * automatically (e.g. when opened from a tenant detail page).
   */
  presetTenantId?: string;
}

/**
 * يحمّل عقود المستأجر غير المؤرشفة للاختيار في المعاينة والإرسال.
 *
 * Archived contracts are excluded everywhere else (migration 82); the
 * messaging dialog must not be the one place they reappear.
 */
function useTenantContracts(tenantId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["tenant-contracts-for-message", tenantId],
    enabled: Boolean(enabled && tenantId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contracts")
        .select("id, code, state, start_date, end_date")
        .eq("tenant_id", tenantId!)
        .is("archived_at", null)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * حوار إرسال رسالة يدوية لمستأجر واحد، مع معاينة حية وربط بالعقد عند التعدّد.
 */
export function SendManualMessageDialog({
  open,
  onOpenChange,
  presetTenantId,
}: SendManualMessageDialogProps) {
  const { t } = useI18n();
  // Template variables the preview could not resolve. A send with any of them
  // would reach the tenant as a literal {{placeholder}} (audit M10).
  // null while the preview is still resolving — blocked until it answers.
  const [unresolvedVariables, setUnresolvedVariables] = useState<string[] | null>(null);
  const [manualTenant, setManualTenant] = useState("");
  const [manualChannel, setManualChannel] = useState<NotificationChannel>("email");
  const [manualLocale, setManualLocale] = useState<LocaleCode | "auto">("auto");
  const [manualTemplate, setManualTemplate] = useState("free");
  const [manualSubject, setManualSubject] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [manualContractId, setManualContractId] = useState<string | null>(null);
  // A template's own copy, pulled into the editable fields for this send only.
  const [templateEditMode, setTemplateEditMode] = useState(false);
  // List only when the picker is shown; preset path loads the exact tenant.
  const tenants = useTenants({ pageSize: 100 }, open && !presetTenantId);
  const presetTenant = useTenant(open && presetTenantId ? presetTenantId : null);
  const sendManual = useSendManualNotification();

  // Keep the internal tenant in sync with the preset whenever the dialog
  // opens or the preset changes.
  useEffect(() => {
    if (presetTenantId) setManualTenant(presetTenantId);
  }, [presetTenantId, open]);

  const effectiveTenantId = presetTenantId ?? manualTenant;
  const selectedTenant = presetTenantId
    ? presetTenant.data
    : tenants.data?.items.find((tenant) => tenant.id === effectiveTenantId);
  const contracts = useTenantContracts(effectiveTenantId || null, open);
  const effectiveManualLocale: LocaleCode =
    manualLocale !== "auto" ? manualLocale : (selectedTenant?.preferred_language ?? "ar");
  const eligible = useTenantEligibleTemplates(manualChannel);

  // Reset contract pin when the tenant changes or only one contract remains.
  useEffect(() => {
    const items = contracts.data ?? [];
    if (items.length === 1) {
      setManualContractId(items[0].id);
    } else if (items.length === 0) {
      setManualContractId(null);
    } else if (manualContractId && !items.some((c) => c.id === manualContractId)) {
      setManualContractId(null);
    }
  }, [contracts.data, manualContractId, effectiveTenantId]);

  // A `company_info` template switches the dialog into "send company info" mode:
  // subject/body are auto-generated server-side and the company PDF is attached.
  const selectedTemplateObj = useMemo(
    () => eligible.data.find((template) => template.code === manualTemplate) ?? null,
    [eligible.data, manualTemplate],
  );
  const isCompanyInfoMode = Boolean(
    selectedTemplateObj && selectedTemplateObj.type === "company_info",
  );
  const isFreeText = manualTemplate === "free";
  // Under a template the fields stay hidden: they used to render empty, and
  // typing in them silently replaced the template with nothing on screen saying
  // so. The resolved preview is what the admin reads instead.
  const showManualFields = isFreeText || templateEditMode;
  const showPreview = !isCompanyInfoMode && Boolean(effectiveTenantId);
  const sendCompanyInfoFn = useServerFn(sendCompanyInfo);
  const [companyInfoPending, setCompanyInfoPending] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Free text only. The hook resolves with templateCode null, so under a
  // template it would advertise the free-text union while the send supplies a
  // template code and resolves only that template's type — an inserted
  // {{invoice_amount}} would then reach the tenant as literal braces.
  const messageVariables = useMessageVariables({
    tenantId: effectiveTenantId,
    contractId: manualContractId,
    locale: effectiveManualLocale,
    enabled: open && isFreeText,
  });

  /**
   * يُدرج متغيّرًا في نص الرسالة عند موضع المؤشّر ويعيد التركيز إليه.
   */
  const insertVariable = (token: string) => {
    const field = bodyRef.current;
    const start = field?.selectionStart ?? manualBody.length;
    const end = field?.selectionEnd ?? manualBody.length;
    const { text, caret } = insertAtCursor(manualBody, token, start, end);
    setManualBody(text);
    // Restored after React commits the new value, or the caret jumps to the end
    // and the next insertion lands in the wrong place.
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  /**
   * يعيد الحقول إلى حالتها الابتدائية عند الإغلاق.
   */
  const handleClose = () => {
    setManualSubject("");
    setManualBody("");
    setManualTemplate("free");
    setManualLocale("auto");
    setManualContractId(null);
    setTemplateEditMode(false);
    if (!presetTenantId) setManualTenant("");
  };

  /**
   * ينسخ نص القالب إلى الحقول لتعديله في هذه الرسالة وحدها.
   *
   * The override path already exists — `buildFinalMessage` resolves
   * `input.subject ?? template.subject_ar` and never writes the template row.
   * All that was missing was pre-filling the fields so there is something to
   * edit.
   *
   * The locale is pinned on the way in. `subject` and `body` are single fields
   * in the send payload, but a template row carries subject_ar/body_ar *and*
   * subject_en/body_en — so on "auto" an Arabic edit would also be rendered as
   * the English body for a tenant whose language is English.
   */
  const startTemplateEdit = () => {
    const template = selectedTemplateObj;
    if (!template) return;
    setManualLocale(effectiveManualLocale);
    setManualSubject(
      (effectiveManualLocale === "ar" ? template.subject_ar : template.subject_en) ?? "",
    );
    setManualBody((effectiveManualLocale === "ar" ? template.body_ar : template.body_en) ?? "");
    setTemplateEditMode(true);
  };

  /**
   * يلغي التعديل المؤقّت ويعيد الرسالة إلى نص القالب المحفوظ.
   */
  const cancelTemplateEdit = () => {
    setTemplateEditMode(false);
    setManualSubject("");
    setManualBody("");
  };

  // Resetting the code alone is not enough: an "edit once" copy left in
  // templateEditMode/subject/body would then be sent as free text under no
  // template at all.
  useEffect(() => {
    if (manualTemplate === "free") return;
    if (eligible.data.some((template) => template.code === manualTemplate)) return;
    setManualTemplate("free");
    cancelTemplateEdit();
  }, [eligible.data, manualTemplate]);

  /**
   * يرسل الرسالة اليدوية أو وضع معلومات الشركة.
   */
  const submit = async () => {
    try {
      if (isCompanyInfoMode) {
        // Company-info mode: the server fn renders the letterhead PDF and
        // attaches it; subject/body are generated server-side.
        const sendChannels =
          manualChannel === "both" ? (["email", "whatsapp"] as const) : ([manualChannel] as const);
        if (!effectiveTenantId) {
          toast.error(t("common.error"));
          return;
        }
        setCompanyInfoPending(true);
        try {
          await sendCompanyInfoFn({
            data: {
              tenantId: effectiveTenantId,
              channels: [...sendChannels],
              locale: manualLocale === "auto" ? undefined : manualLocale,
            },
          });
          // The document is queued, not sent: the worker renders the PDF and
          // the notify worker delivers it.
          toast.success(t("notifications.companyInfoQueued"));
          onOpenChange(false);
          handleClose();
        } finally {
          setCompanyInfoPending(false);
        }
        return;
      }
      await sendManual.mutateAsync({
        tenantId: effectiveTenantId,
        type: "manual_message",
        channel: manualChannel,
        locale: manualLocale === "auto" ? null : manualLocale,
        templateCode: manualTemplate === "free" ? null : manualTemplate,
        subject: manualSubject || null,
        body: manualBody || null,
        contractId: manualContractId,
      });
      // The message is queued, not sent: `sendNotification` writes the row and
      // the notify worker delivers it. Claiming "sent" here would report a
      // delivery that has not happened — and that no provider has accepted yet.
      toast.success(t("deferred.messageQueued"));
      onOpenChange(false);
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  const multiContract = (contracts.data ?? []).length > 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) handleClose();
        onOpenChange(value);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("notifications.sendManual")}</DialogTitle>
          <DialogDescription>{t("notifications.manualHelp")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!presetTenantId && (
            <div className="space-y-2">
              <Label required>{t("notifications.tenant")}</Label>
              {/*
                Changing tenant cancels an in-progress edit. `effectiveManualLocale`
                falls back to the tenant's preferred_language, so a pin taken for
                one tenant would hold Arabic template text against a tenant who
                reads English.
              */}
              <Select
                value={manualTenant}
                onValueChange={(value) => {
                  setManualTenant(value);
                  cancelTemplateEdit();
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(tenants.data?.items ?? []).map((tenant, index) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                        {tenant.code} — {tenant.name}
                        {tenant.reminders_enabled ? "" : ` · ${t("notifications.remindersOff")}`}
                      </TenantOptionLabel>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {presetTenantId && selectedTenant && !selectedTenant.reminders_enabled && (
            <Badge variant="outline">{t("notifications.remindersOff")}</Badge>
          )}
          {multiContract ? (
            <div className="space-y-2">
              <Label>{t("notifications.previewContract")}</Label>
              <Select
                value={manualContractId ?? ""}
                onValueChange={(value) => setManualContractId(value || null)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(contracts.data ?? []).map((contract) => (
                    <SelectItem key={contract.id} value={contract.id}>
                      {contract.code} ({contract.state})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>{t("notifications.channel")}</Label>
            <Select
              value={manualChannel}
              onValueChange={(value) => setManualChannel(value as NotificationChannel)}
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
            <Select
              value={manualLocale}
              disabled={templateEditMode}
              onValueChange={(value) => setManualLocale(value as LocaleCode | "auto")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {t("common.auto")}
                  {selectedTenant ? ` (${selectedTenant.preferred_language.toUpperCase()})` : ""}
                </SelectItem>
                <SelectItem value="ar">AR — العربية</SelectItem>
                <SelectItem value="en">EN — English</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("notifications.template")}</Label>
            <Select
              value={manualTemplate}
              onValueChange={(value) => {
                setManualTemplate(value);
                // A stale edit carried onto another template would send one
                // template's text under a different template's name.
                cancelTemplateEdit();
              }}
            >
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
                      locale={effectiveManualLocale}
                    />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {showPreview ? (
            <MessagePreviewPanel
              tenantId={effectiveTenantId}
              // Free text has no template row; the panel resolves the body alone.
              templateCode={isFreeText ? null : manualTemplate}
              contractId={manualContractId}
              channel={manualChannel}
              subject={manualSubject || null}
              body={manualBody || null}
              // A one-off edit is written in one language and must preview in
              // that language only — the other tab keeps the stored copy.
              overrideLocale={templateEditMode ? effectiveManualLocale : undefined}
              onUnresolvedChange={setUnresolvedVariables}
            />
          ) : null}
          {isCompanyInfoMode ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {t("notifications.companyInfoMode")}
            </div>
          ) : (
            <>
              {!isFreeText && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={templateEditMode ? "secondary" : "outline"}
                    onClick={templateEditMode ? cancelTemplateEdit : startTemplateEdit}
                  >
                    {t("notifications.editTemplateOnce")}
                  </Button>
                  {templateEditMode && (
                    <p className="text-xs text-muted-foreground">
                      {t("notifications.editTemplateOnceHelp")}{" "}
                      {t("notifications.editTemplateLocalePinned")}
                    </p>
                  )}
                </div>
              )}
              {showManualFields && (
                <>
                  <div className="space-y-2">
                    <Label>{t("notifications.subject")}</Label>
                    <Input
                      value={manualSubject}
                      onChange={(event) => setManualSubject(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t("notifications.body")}</Label>
                    <Textarea
                      ref={bodyRef}
                      rows={6}
                      value={manualBody}
                      onChange={(event) => setManualBody(event.target.value)}
                    />
                    {isFreeText && (
                      <VariableChips values={messageVariables.values} onInsert={insertVariable} />
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              handleClose();
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !effectiveTenantId ||
              (!isCompanyInfoMode && manualTemplate === "free" && !manualBody.trim()) ||
              sendManual.isPending ||
              companyInfoPending ||
              (showPreview && (unresolvedVariables === null || unresolvedVariables.length > 0))
            }
            onClick={submit}
          >
            {t("notifications.sendManual")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
