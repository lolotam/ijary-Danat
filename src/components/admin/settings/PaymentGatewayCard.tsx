import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CreditCard } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import { Switch } from "@/components/ui/switch";
import {
  gatewayActivate,
  gatewayDeactivate,
  gatewayList,
  gatewaySaveCredentials,
  gatewayTestConnection,
  type GatewayListItem,
} from "@/fns/gatewaySettings";
import { gatewayConnectionIds } from "@/fns/portalPaymentAvailability";
import { GATEWAY_PROVIDERS, type GatewayProvider } from "@/gateways/types";
import { useI18n } from "@/i18n/provider";
import { describeError } from "@/lib/toastError";

/*
 * بطاقة إعدادات بوابات الدفع في صفحة تكاملات الشركة: مزوّد في كل قسم،
 * أسرار تُكتب ولا تُعرض مرة أخرى، واختبار وتفعيل لاتصال واحد نشط.
 *
 * The browser only ever sees `GatewayListItem` previews (`last4`) from the
 * server function. Nothing here reads decrypted credentials or logs them.
 */

/** مفتاح استعلام حالة اتصالات البوابات في شاشة الإعدادات. */
const GATEWAY_LIST_QUERY_KEY = ["gateway-settings-list"] as const;

/** مفتاح استعلام معرّفات الاتصالات المستخدمة في عناوين الويب هوك. */
const GATEWAY_IDS_QUERY_KEY = ["gateway-settings-ids"] as const;

/** حقل سرّ يظهر للمستخدم باسمه، وقيمته المخزّنة لا تُملأ في النموذج. */
interface CredentialField {
  name: string;
  labelKey: string;
}

/**
 * حقول بيانات الاعتماد في أقسام المزوّدين.
 *
 * The webhook route reads `webhookSecret` for every provider and the adapter
 * path reads `apiKey`, so the same two fields serve all three sections until a
 * provider's own adapter defines a different scheme.
 */
const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  { name: "apiKey", labelKey: "gatewaySettingsUi.credential.apiKey" },
  { name: "webhookSecret", labelKey: "gatewaySettingsUi.credential.webhookSecret" },
];

/** نتيجة اختبار الاتصال كما تُعرض في القسم الخاص بالمزوّد. */
interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/** مدخلات حفظ بيانات الاعتماد المرسلة إلى دالة الخادم. */
interface SaveGatewayInput {
  provider: GatewayProvider;
  mode: "test" | "live";
  credentials: Record<string, string>;
}

/**
 * يختار شارة الحالة التي تُعرض بجانب اسم المزوّد.
 */
function statusLabelKey(connection: GatewayListItem): string {
  if (!connection.configured) return "gatewaySettingsUi.badge.notSet";
  if (!connection.isActive) return "gatewaySettingsUi.badge.inactive";
  return connection.mode === "live"
    ? "gatewaySettingsUi.badge.live"
    : "gatewaySettingsUi.badge.test";
}

/**
 * يأخذ الحقول التي كتبها المستخدم فقط، دون لمس القيم المحفوظة التي لا تُعرض.
 */
function filledCredentials(
  fields: readonly CredentialField[],
  draft: Record<string, string>,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = draft[field.name]?.trim() ?? "";
    if (value) credentials[field.name] = value;
  }
  return credentials;
}

/**
 * يعيد رسالة الخطأ القادمة من الخادم، أو النص العام إن لم تكن رسالةً قياسية.
 */
function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * يعرض رابط الويب هوك بعد وجود اتصال، مع زرّ نسخ لا يبتلع خطأ النسخ.
 */
function WebhookUrlRow({
  provider,
  connectionId,
}: {
  provider: GatewayProvider;
  connectionId: string;
}) {
  const { t } = useI18n();
  const url = `/api/public/webhooks/${provider}/${connectionId}`;

  /**
   * ينسخ رابط الويب هوك ويُخبر المستخدم إن تعذّر ذلك.
   */
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("gatewaySettingsUi.copied"));
    } catch {
      toast.error(t("gatewaySettingsUi.copyFailed"));
    }
  }

  return (
    <div className="space-y-1">
      <Label>{t("gatewaySettingsUi.webhookLabel")}</Label>
      <div className="flex flex-wrap connections-center gap-2">
        <LtrText className="min-w-0 flex-1 break-all rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs">
          {url}
        </LtrText>
        <Button type="button" variant="outline" size="sm" onClick={() => void copyUrl()}>
          <Copy className="size-4" />
          {t("gatewaySettingsUi.copy")}
        </Button>
      </div>
    </div>
  );
}

/**
 * قسم مزوّد واحد: الحالة، نموذج الأسرار للكتابة فقط، الاختبار، والتفعيل.
 */
function ProviderSection({
  connection,
  connectionId,
  busy,
  testResult,
  error,
  onSave,
  onTest,
  onActivate,
  onDeactivate,
}: {
  connection: GatewayListItem;
  connectionId: string | null;
  busy: boolean;
  testResult: ProviderTestResult | null;
  error: string | null;
  onSave: (input: SaveGatewayInput) => void;
  onTest: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"test" | "live">(connection.mode);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A save or activation rewrites the row; the toggle must follow the stored
  // mode rather than keep a stale local choice from before the refresh.
  useEffect(() => {
    setMode(connection.mode);
  }, [connection.mode]);

  /**
   * يحدّث حقل سرّ واحداً في مسوّدة الكتابة المحلية.
   */
  function updateDraft(name: string, value: string) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  /**
   * يرسل الحقول غير الفارغة إلى الحفظ، ويرفض الحفظ بلا سرّ جديد.
   */
  function saveDraft() {
    const credentials = filledCredentials(CREDENTIAL_FIELDS, draft);
    if (Object.keys(credentials).length === 0) {
      toast.error(t("gatewaySettingsUi.enterCredential"));
      return;
    }
    onSave({ provider: connection.provider, mode, credentials });
    setDraft({});
  }

  /**
   * ينفّذ الإجراء المؤكَّد ويغلق مربع التأكيد.
   */
  function confirmAction() {
    if (connection.isActive) onDeactivate();
    else onActivate();
    setConfirmOpen(false);
  }

  return (
    <section className="space-y-4 rounded-lg border border-border/70 p-4">
      <div className="flex flex-wrap connections-center justify-between gap-2">
        <h3 className="font-semibold">{t(`gatewaySettingsUi.provider.${connection.provider}`)}</h3>
        <Badge variant={connection.isActive ? "secondary" : "outline"}>
          {t(statusLabelKey(connection))}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CREDENTIAL_FIELDS.map((field) => {
          const preview = connection.secretPreviews.find((entry) => entry.name === field.name);
          return (
            <div key={field.name} className="space-y-1">
              <Label htmlFor={`gateway-${connection.provider}-${field.name}`}>
                {t(field.labelKey)}
              </Label>
              <Input
                id={`gateway-${connection.provider}-${field.name}`}
                type="password"
                autoComplete="off"
                value={draft[field.name] ?? ""}
                onChange={(event) => updateDraft(field.name, event.target.value)}
                placeholder={preview ? `•••• ${preview.last4}` : undefined}
              />
              {preview ? (
                <p className="text-xs text-muted-foreground">
                  {t("gatewaySettingsUi.credential.stored")} <LtrText>{preview.last4}</LtrText>
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap connections-center gap-2">
        <Switch
          id={`gateway-${connection.provider}-test-mode`}
          checked={mode === "test"}
          onCheckedChange={(checked) => setMode(checked ? "test" : "live")}
          disabled={busy}
        />
        <Label htmlFor={`gateway-${connection.provider}-test-mode`}>
          {t("gatewaySettingsUi.testMode")}
        </Label>
        <span className="text-xs text-muted-foreground">
          {t(mode === "test" ? "gatewaySettingsUi.mode.test" : "gatewaySettingsUi.mode.live")}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{t("gatewaySettingsUi.credential.hint")}</p>

      {error ? (
        <p role="alert" className="text-sm text-destructive" dir="ltr">
          {error}
        </p>
      ) : null}
      {testResult ? (
        <div className="space-y-1 text-sm">
          <p className={testResult.ok ? "text-emerald-700" : "text-destructive"}>
            {t(testResult.ok ? "gatewaySettingsUi.testOk" : "gatewaySettingsUi.testFailed")}
          </p>
          <p className="text-xs text-muted-foreground" dir="ltr">
            {testResult.message}
          </p>
        </div>
      ) : null}
      {connection.configured && connection.lastTestAt ? (
        <p className="text-xs text-muted-foreground">
          {t("gatewaySettingsUi.lastTestAt")}: {new Date(connection.lastTestAt).toLocaleString()}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={saveDraft}>
          {t("gatewaySettingsUi.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !connection.configured}
          onClick={onTest}
        >
          {t("gatewaySettingsUi.testConnection")}
        </Button>
        {connection.configured ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            {t(connection.isActive ? "gatewaySettingsUi.deactivate" : "gatewaySettingsUi.activate")}
          </Button>
        ) : null}
      </div>

      {connection.configured && connectionId ? (
        <WebhookUrlRow provider={connection.provider} connectionId={connectionId} />
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                connection.isActive
                  ? "gatewaySettingsUi.confirmDeactivateTitle"
                  : "gatewaySettingsUi.confirmActivateTitle",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                connection.isActive
                  ? "gatewaySettingsUi.confirmDeactivateBody"
                  : "gatewaySettingsUi.confirmActivateBody",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">{t("gatewaySettingsUi.cancel")}</Button>
            </AlertDialogCancel>
            <Button type="button" disabled={busy} onClick={confirmAction}>
              {t("gatewaySettingsUi.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * بطاقة إعدادات بوابات الدفع: مزوّد واحد نشط كحد أقصى للشركة.
 */
export function PaymentGatewayCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [errorByProvider, setErrorByProvider] = useState<Partial<Record<GatewayProvider, string>>>(
    {},
  );
  const [testByProvider, setTestByProvider] = useState<
    Partial<Record<GatewayProvider, ProviderTestResult>>
  >({});

  const connectionsQuery = useQuery({
    queryKey: GATEWAY_LIST_QUERY_KEY,
    queryFn: (): Promise<GatewayListItem[]> => gatewayList(),
  });
  const connectionIdsQuery = useQuery({
    queryKey: GATEWAY_IDS_QUERY_KEY,
    queryFn: () => gatewayConnectionIds(),
  });

  /**
   * يحدّث رسالة مزوّد واحداً ويُمسح رسائله عند نجاح إجراء لاحق.
   */
  function recordError(provider: GatewayProvider, message: string | null) {
    setErrorByProvider((current) => ({ ...current, [provider]: message ?? undefined }));
  }

  /**
   * يعيد قراءة الحالة والمعرّفات بعد أي تغيير على الاتصالات.
   */
  function refreshConnections() {
    void queryClient.invalidateQueries({ queryKey: GATEWAY_LIST_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: GATEWAY_IDS_QUERY_KEY });
  }

  const saveCredentials = useMutation({
    mutationFn: (input: SaveGatewayInput) =>
      gatewaySaveCredentials({
        data: {
          provider: input.provider,
          mode: input.mode,
          publicConfig: {},
          credentials: input.credentials,
        },
      }),
    onSuccess: (_result, input) => {
      toast.success(t("gatewaySettingsUi.saved"));
      recordError(input.provider, null);
      refreshConnections();
    },
    onError: (cause, input) => {
      const message = failureMessage(cause, t("gatewaySettingsUi.saveError"));
      recordError(input.provider, message);
      toast.error(t("gatewaySettingsUi.saveError"), { description: describeError(cause) });
    },
  });

  const testConnectionMutation = useMutation({
    mutationFn: (provider: GatewayProvider) => gatewayTestConnection({ data: { provider } }),
    onSuccess: (result, provider) => {
      setTestByProvider((current) => ({ ...current, [provider]: result }));
      recordError(provider, null);
      refreshConnections();
    },
    onError: (cause, provider) => {
      recordError(provider, failureMessage(cause, t("gatewaySettingsUi.testFailed")));
    },
  });

  const activateMutation = useMutation({
    mutationFn: (provider: GatewayProvider) => gatewayActivate({ data: { provider } }),
    onSuccess: (_result, provider) => {
      toast.success(t("gatewaySettingsUi.activated"));
      recordError(provider, null);
      refreshConnections();
    },
    onError: (cause, provider) => {
      const message = failureMessage(cause, t("gatewaySettingsUi.actionError"));
      recordError(provider, message);
      toast.error(t("gatewaySettingsUi.actionError"), { description: describeError(cause) });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (provider: GatewayProvider) => gatewayDeactivate({ data: { provider } }),
    onSuccess: (_result, provider) => {
      toast.success(t("gatewaySettingsUi.deactivated"));
      recordError(provider, null);
      refreshConnections();
    },
    onError: (cause, provider) => {
      const message = failureMessage(cause, t("gatewaySettingsUi.actionError"));
      recordError(provider, message);
      toast.error(t("gatewaySettingsUi.actionError"), { description: describeError(cause) });
    },
  });

  const busy =
    saveCredentials.isPending ||
    testConnectionMutation.isPending ||
    activateMutation.isPending ||
    deactivateMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex connections-center gap-2 text-base">
          <CreditCard className="size-4" />
          {t("gatewaySettingsUi.title")}
        </CardTitle>
        <CardDescription>{t("gatewaySettingsUi.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connectionsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : null}
        {connectionsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t("common.error")}
          </p>
        ) : null}
        {GATEWAY_PROVIDERS.map((provider) => {
          const connection = connectionsQuery.data?.find((entry) => entry.provider === provider);
          if (!connection) return null;
          return (
            <ProviderSection
              key={provider}
              connection={connection}
              connectionId={connectionIdsQuery.data?.[provider] ?? null}
              busy={busy}
              testResult={testByProvider[provider] ?? null}
              error={errorByProvider[provider] ?? null}
              onSave={(input) => saveCredentials.mutate(input)}
              onTest={() => testConnectionMutation.mutate(provider)}
              onActivate={() => activateMutation.mutate(provider)}
              onDeactivate={() => deactivateMutation.mutate(provider)}
            />
          );
        })}
        <p className="text-xs text-muted-foreground">{t("gatewaySettingsUi.oneActive")}</p>
      </CardContent>
    </Card>
  );
}
