import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolveTemplateVariables, type FinalMessage } from "@/fns/resolveTemplateVariables";
import { useI18n } from "@/i18n/provider";
import type { LocaleCode, NotificationChannel } from "@/integrations/supabase/database.types";

type PreviewTab = "html" | "text" | "source";

export interface MessagePreviewViewProps {
  /** Resolved Arabic preview, or null while loading / no template. */
  ar: FinalMessage | null;
  /** Resolved English preview. */
  en: FinalMessage | null;
  loading?: boolean;
  error?: string | null;
  /** When true, show the bulk-sample notice above the panel. */
  sampleNotice?: boolean;
  empty?: boolean;
}

/**
 * لوحة عرض معاينة الرسالة (خالية من الجلب) — للاختبار وللتفاف التحميل.
 *
 * The HTML tab renders into <iframe sandbox srcDoc>, never into the admin
 * console's own DOM: a notification template is admin-authored markup, and
 * injecting it into a privileged session would let a template body run script.
 *
 * subject comes from RAW values and bodyHtml from escaped values — same split
 * as buildFinalMessage / loadTemplateCopy.
 */
export function MessagePreviewView({
  ar,
  en,
  loading = false,
  error = null,
  sampleNotice = false,
  empty = false,
}: MessagePreviewViewProps) {
  const { t } = useI18n();
  const [previewLocale, setPreviewLocale] = useState<LocaleCode>("ar");
  const [tab, setTab] = useState<PreviewTab>("html");

  const copy = previewLocale === "ar" ? ar : en;
  const missing = useMemo(() => {
    if (copy?.unavailableReason) return [];
    return copy?.missing ?? [];
  }, [copy]);

  if (empty) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {t("notifications.previewEmpty")}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm font-medium">{t("notifications.preview")}</Label>
        <Select
          value={previewLocale}
          onValueChange={(value) => setPreviewLocale(value as LocaleCode)}
        >
          <SelectTrigger className="w-[9rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ar">AR — العربية</SelectItem>
            <SelectItem value="en">EN — English</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {sampleNotice ? (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
          {t("notifications.bulkSampleNotice")}
        </p>
      ) : null}

      {loading ? <p className="text-xs text-muted-foreground">{t("common.loading")}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {copy?.unavailableReason ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          {t("notifications.previewLocaleUnavailable")}
          <p className="mt-1 text-xs opacity-80">{copy.unavailableReason}</p>
        </div>
      ) : null}

      {missing.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
          <p className="font-medium">{t("notifications.previewMissing")}</p>
          <ul className="mt-1 list-disc ps-4">
            {missing.map((key) => (
              <li key={key}>
                <code>{`{{${key}}}`}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {copy && !copy.unavailableReason ? (
        <>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("notifications.subject")}</p>
            <p className="text-sm font-medium">{copy.subject || "—"}</p>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as PreviewTab)}>
            <TabsList>
              <TabsTrigger value="html">{t("notifications.previewHtml")}</TabsTrigger>
              <TabsTrigger value="text">{t("notifications.previewText")}</TabsTrigger>
              <TabsTrigger value="source">{t("notifications.previewSource")}</TabsTrigger>
            </TabsList>
            <TabsContent value="html" className="mt-2">
              <iframe
                title={t("notifications.preview")}
                sandbox=""
                srcDoc={copy.bodyHtml || "<p></p>"}
                className="h-48 w-full rounded-md border bg-white"
              />
            </TabsContent>
            <TabsContent value="text" className="mt-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                {copy.bodyText || "—"}
              </pre>
            </TabsContent>
            <TabsContent value="source" className="mt-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                {copy.bodyHtml || "—"}
              </pre>
            </TabsContent>
          </Tabs>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("notifications.previewVariables")}</p>
            <div className="flex flex-wrap gap-1">
              {Object.entries(copy.variables).map(([key, value]) => (
                <Badge key={key} variant="outline" className="font-mono text-[10px]">
                  {key}={value || "∅"}
                </Badge>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * لوحة معاينة الرسالة قبل الإرسال، بصيغة HTML أو نص عادي، بالعربية والإنجليزية.
 *
 * Calls buildFinalMessage (via resolveTemplateVariables) once per locale so
 * preview and send share one builder. Each locale loads that locale's own
 * template row — never the other language's body rendered twice.
 */
export interface MessagePreviewProps {
  tenantId: string;
  templateCode: string | null;
  contractId: string | null;
  channel: NotificationChannel;
  /** Free-text / override fields — must match the send payload. */
  subject?: string | null;
  body?: string | null;
  variables?: Record<string, string>;
  /**
   * اللغة التي تخصّها التجاوزات — التبويب الآخر يعرض نص القالب المحفوظ.
   *
   * subject/body are single fields but this panel renders two locales side by
   * side. Handing the same override to both showed a one-off Arabic edit as the
   * English body as well — a preview of a message that would never be sent.
   */
  overrideLocale?: LocaleCode;
  /** Label the panel as a bulk sample rather than the final message. */
  sampleNotice?: boolean;
  /**
   * يُبلَّغ بمتغيرات القالب التي لم تُحَلّ، ليمنع المستدعي الإرسال.
   *
   * The union across both locales: the message goes out in the tenant's
   * locale, which this panel does not know, and a variable missing from one
   * rendering is missing from the data both render from (audit M10).
   *
   * `null` means "not known yet": a preview is (re)fetching. Every edit to the
   * template, body, contract or locale gives the queries a new key, and while
   * they refetch their data is undefined — reporting `[]` then re-enabled Send
   * until the new preview arrived, so a fast click could send literal
   * placeholders. A caller must treat `null` as blocked.
   */
  onUnresolvedChange?: (keys: string[] | null) => void;
}

/**
 * يقرّر ما إذا كانت هناك رسالة تستحق المعاينة أصلًا.
 *
 * Free text has no template code but does have a body, and buildFinalMessage
 * resolves that perfectly well. Requiring a code left an admin writing free
 * text looking at their own {{braces}} with no way to check what would be sent.
 *
 * Exported so the rule is testable — the suite runs without a DOM and cannot
 * mount the panel.
 */
export function previewEnabled(
  props: Pick<MessagePreviewProps, "tenantId" | "templateCode" | "body">,
): boolean {
  return Boolean(props.tenantId && (props.templateCode || props.body?.trim()));
}

/**
 * يبني حمولة المعاينة للغة واحدة — نفس حقول الإرسال.
 *
 * Overrides apply only to the locale they were written in; the other tab falls
 * back to the stored template copy.
 */
export function buildPreviewPayload(props: MessagePreviewProps, locale: LocaleCode) {
  const overrideApplies = !props.overrideLocale || props.overrideLocale === locale;
  return {
    tenantId: props.tenantId,
    templateCode: props.templateCode,
    locale,
    contractId: props.contractId,
    subject: overrideApplies ? (props.subject ?? null) : null,
    body: overrideApplies ? (props.body ?? null) : null,
    variables: props.variables,
  };
}

export function MessagePreviewPanel(props: MessagePreviewProps) {
  const resolveFn = useServerFn(resolveTemplateVariables);
  const enabled = previewEnabled(props);

  const payloadFor = (locale: LocaleCode) => buildPreviewPayload(props, locale);

  const arQuery = useQuery({
    queryKey: [
      "resolveTemplateVariables",
      props.tenantId,
      props.templateCode,
      props.contractId,
      props.subject,
      props.body,
      props.overrideLocale,
      props.variables,
      "ar",
    ],
    enabled,
    queryFn: () => resolveFn({ data: payloadFor("ar") }),
  });

  const enQuery = useQuery({
    queryKey: [
      "resolveTemplateVariables",
      props.tenantId,
      props.templateCode,
      props.contractId,
      props.subject,
      props.body,
      props.overrideLocale,
      props.variables,
      "en",
    ],
    enabled,
    queryFn: () => resolveFn({ data: payloadFor("en") }),
  });

  const arMissing = (arQuery.data as FinalMessage | undefined)?.missing;
  const enMissing = (enQuery.data as FinalMessage | undefined)?.missing;
  const { onUnresolvedChange } = props;
  const unresolvedKey = [...new Set([...(arMissing ?? []), ...(enMissing ?? [])])].sort().join(",");
  const resolving = enabled && (arQuery.isFetching || enQuery.isFetching);
  useEffect(() => {
    if (resolving) onUnresolvedChange?.(null);
    else onUnresolvedChange?.(enabled && unresolvedKey ? unresolvedKey.split(",") : []);
  }, [enabled, resolving, unresolvedKey, onUnresolvedChange]);

  const errorMessage =
    arQuery.error instanceof Error
      ? arQuery.error.message
      : enQuery.error instanceof Error
        ? enQuery.error.message
        : null;

  return (
    <MessagePreviewView
      ar={(arQuery.data as FinalMessage | undefined) ?? null}
      en={(enQuery.data as FinalMessage | undefined) ?? null}
      loading={enabled && (arQuery.isLoading || enQuery.isLoading)}
      error={errorMessage}
      sampleNotice={props.sampleNotice}
      empty={!enabled}
    />
  );
}
