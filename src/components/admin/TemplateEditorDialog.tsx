import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateNotificationTemplate,
  useUpdateNotificationTemplate,
} from "@/hooks/useNotificationTemplates";
import { useI18n } from "@/i18n/provider";
import type {
  LocaleCode,
  NotificationChannel,
  NotificationType,
  Tables,
} from "@/integrations/supabase/database.types";
import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";
import { applyEmailLogo } from "@/lib/emailLogo";
import { emailBrandName, renderEmailDocument, type EmailLocale } from "@/lib/emailTemplates";
import { useCompany } from "@/hooks/useCompany";
import { renderTemplate } from "@/lib/templateRender";
import { TEMPLATE_VARIABLES, sampleVariablesFor } from "@/lib/templateVariables";

const channels: NotificationChannel[] = ["email", "whatsapp", "both"];

interface TemplateDraft {
  bodyAr: string;
  bodyEn: string;
  channel: NotificationChannel;
  code: string;
  subjectAr: string;
  subjectEn: string;
  type: NotificationType;
}

const emptyTemplate: TemplateDraft = {
  bodyAr: "",
  bodyEn: "",
  channel: "email",
  code: "",
  subjectAr: "",
  subjectEn: "",
  type: "manual_message",
};

/**
 * One body field: HTML source, or a preview of what that HTML becomes.
 *
 * The preview renders through renderEmailDocument — the same function the
 * senders call — so it is honest by construction rather than by a second
 * implementation kept in step.
 *
 * It renders inside an EMPTY-sandbox iframe: no allow-scripts, no
 * allow-same-origin. Admin-authored HTML therefore cannot run script, reach the
 * session, or escape into the admin layout, and a malformed template breaks only
 * its own pane. That is why no HTML sanitiser is used — the body is *meant* to
 * contain arbitrary markup, authored by someone who may already change what the
 * system emails. The isolation protects the admin app from broken HTML, not the
 * system from the admin.
 */
function BodyField({
  label,
  locale,
  value,
  onChange,
  type,
  textareaRef,
}: {
  label: string;
  locale: EmailLocale;
  value: string;
  onChange: (next: string) => void;
  type: NotificationType;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"source" | "preview">("source");

  const company = useCompany();
  // The send path substitutes the logo marker; the preview must do the same or
  // the admin reviews a document that differs from what goes out. Falls back to
  // the app logo exactly as `emailLogoFor` does on the server.
  const emailLogo = company.data?.email_logo_url ?? company.data?.logo_url ?? null;

  const previewHtml = useMemo(() => {
    const rendered = renderTemplate(value, sampleVariablesFor(type)) ?? "";
    const document = renderEmailDocument(locale, label, rendered);
    return applyEmailLogo(document, emailLogo, emailBrandName(locale));
  }, [value, locale, label, type, emailLogo]);

  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "source" | "preview")}>
          <TabsList className="h-8">
            <TabsTrigger value="source" className="text-xs">
              {t("templates.sourceTab")}
            </TabsTrigger>
            <TabsTrigger value="preview" className="text-xs">
              {t("templates.previewTab")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "source" ? (
        <Textarea
          ref={textareaRef}
          dir="ltr"
          rows={12}
          className="font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <iframe
          // Empty sandbox: maximum restriction. Do not add allow-scripts.
          sandbox=""
          srcDoc={previewHtml}
          title={`${label} preview`}
          className="h-[22rem] w-full rounded-md border bg-white"
        />
      )}
    </div>
  );
}

export function TemplateEditorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Tables<"notification_templates"> | null;
}) {
  const { open, onOpenChange, template } = props;
  const { t, locale } = useI18n();
  const createTemplate = useCreateNotificationTemplate();
  const updateTemplate = useUpdateNotificationTemplate();
  const [draft, setDraft] = useState<TemplateDraft>(emptyTemplate);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [editLang, setEditLang] = useState<LocaleCode>("ar");

  useEffect(() => {
    if (!open) return;
    setDraft(
      template
        ? {
            bodyAr: template.body_ar ?? "",
            bodyEn: template.body_en ?? "",
            channel: template.channel,
            code: template.code,
            subjectAr: template.subject_ar ?? "",
            subjectEn: template.subject_en ?? "",
            type: template.type,
          }
        : emptyTemplate,
    );
    setEditLang("ar");
  }, [open, template]);

  /**
   * يدرج عنصرًا نائبًا في جسم اللغة المعروضة حاليًا.
   *
   * editLang is view-state, not a stored column — inserting into the hidden
   * language would edit a field the admin cannot see.
   */
  const insertPlaceholder = (key: string) => {
    const token = `{{${key}}}`;
    const field = editLang === "ar" ? "bodyAr" : "bodyEn";
    const el = bodyRef.current;
    setDraft((current) => {
      const currentValue = current[field];
      if (!el) return { ...current, [field]: currentValue + token };
      const start = el.selectionStart ?? currentValue.length;
      const end = el.selectionEnd ?? currentValue.length;
      const next = currentValue.slice(0, start) + token + currentValue.slice(end);
      // Restore caret after React re-render
      queueMicrotask(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
      return { ...current, [field]: next };
    });
  };

  /**
   * يحفظ القالب دون عمود اللغة — الصف الواحد يحمل اللغتين.
   */
  const save = async () => {
    try {
      const values = {
        code: draft.code,
        type: draft.type,
        channel: draft.channel,
        subject_ar: draft.subjectAr || null,
        subject_en: draft.subjectEn || null,
        body_ar: draft.bodyAr || null,
        body_en: draft.bodyEn || null,
      };
      if (template) await updateTemplate.mutateAsync({ id: template.id, updates: values });
      else await createTemplate.mutateAsync(values);
      toast.success(t("common.saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("templates.editor")}</DialogTitle>
          {/*
            This used to render `notifications.placeholders`, a hand-written list
            that had drifted: it named {{months_until_expiry}}, removed as a
            defect by migration 58, and {{period}}, which only document_send
            resolves. It also contradicted the accurate, type-specific chips
            this dialog already renders below. Point at those instead.
          */}
          <DialogDescription>{t("templates.editorHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t("notifications.language")}</Label>
          <Select value={editLang} onValueChange={(value) => setEditLang(value as LocaleCode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ar">AR — العربية</SelectItem>
              <SelectItem value="en">EN — English</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            {/* The only field this dialog validates — Save stays disabled while
                it is blank. The subject and body fields are genuinely optional:
                a template with no row falls back to the built-in builder. */}
            <Label required>{t("common.code")}</Label>
            <Input
              dir="ltr"
              value={draft.code}
              onChange={(event) =>
                setDraft((current) => ({ ...current, code: event.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>{t("common.type")}</Label>
            <Select
              value={draft.type}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, type: value as NotificationType }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`notificationType.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("notifications.channel")}</Label>
            <Select
              value={draft.channel}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  channel: value as NotificationChannel,
                }))
              }
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
          <div className="space-y-2 sm:col-span-2">
            <Label>{editLang === "ar" ? t("templates.subjectAr") : t("templates.subjectEn")}</Label>
            <Input
              dir={editLang === "en" ? "ltr" : undefined}
              value={editLang === "ar" ? draft.subjectAr : draft.subjectEn}
              onChange={(event) =>
                setDraft((current) =>
                  editLang === "ar"
                    ? { ...current, subjectAr: event.target.value }
                    : { ...current, subjectEn: event.target.value },
                )
              }
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">{t("templates.placeholders")}</Label>
            <div className="flex flex-wrap gap-1">
              {(TEMPLATE_VARIABLES[draft.type] ?? []).map((spec) => (
                <button
                  key={spec.key}
                  type="button"
                  className="rounded border bg-muted px-2 py-0.5 font-mono text-xs hover:bg-accent"
                  title={locale === "ar" ? spec.labelAr : spec.labelEn}
                  onClick={() => insertPlaceholder(spec.key)}
                >
                  {`{{${spec.key}}}`}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("templates.previewNote")}</p>
            <p className="text-xs text-muted-foreground">{t("templates.fullDocumentNote")}</p>
          </div>

          <BodyField
            label={editLang === "ar" ? t("templates.bodyAr") : t("templates.bodyEn")}
            locale={editLang}
            value={editLang === "ar" ? draft.bodyAr : draft.bodyEn}
            onChange={(next) =>
              setDraft((current) =>
                editLang === "ar" ? { ...current, bodyAr: next } : { ...current, bodyEn: next },
              )
            }
            type={draft.type}
            textareaRef={bodyRef}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!draft.code.trim() || createTemplate.isPending || updateTemplate.isPending}
            onClick={save}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
