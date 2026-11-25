import { useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { ImageSourceInput } from "@/components/admin/ImageSourceInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { RESEND_SENDER_LIST_CODE } from "@/fns/resendMailboxSend";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import type { Json, NotificationProvider } from "@/integrations/supabase/database.types";
import { useI18n } from "@/i18n/provider";
import { validateProviderConfig } from "@/lib/providers/configValidation";
import type { EmailRole } from "@/lib/providers/emailRole";
import {
  configValue,
  draftToConfig,
  providerFieldKeys,
  storedConfig,
} from "@/lib/providers/providerFields";

/**
 * بطاقة مزوّد واحد: مفتاح التفعيل وحقول الإعدادات مضمّنة داخلها.
 *
 * Replaces a raw JSON textarea. The keys never hold a credential — they name the
 * environment variable the server reads it from (migration 07's constraint), so
 * these are ordinary text inputs and not password fields; masking them would
 * imply a secret is stored here and invite someone to paste one in.
 */
export function ProviderConfigCard({
  provider,
  config,
  isEnabled,
  fromEmail,
  emailLogoUrl,
  draft,
  onDraftChange,
  onToggle,
  onSave,
  saving,
  emailRole,
  onEmailRoleChange,
}: {
  provider: NotificationProvider;
  config: Json | null;
  isEnabled: boolean;
  /** `provider_configs.from_email` — a column, not a `config` key. */
  fromEmail?: string | null;
  /** `companies.email_logo_url`; owned by the company row, saved by its own hook. */
  emailLogoUrl?: string;
  draft: Record<string, string> | undefined;
  onDraftChange: (next: Record<string, string>) => void;
  onToggle: (enabled: boolean) => void;
  onSave: (updates: {
    config: Json;
    from_email?: string | null;
    /** Present only when the admin changed it; `null` clears the stored logo. */
    email_logo_url?: string | null;
  }) => void;
  saving: boolean;
  /**
   * Email cards only: whether this provider sends first ("primary") or only
   * after the other refuses ("fallback"). Omitted for WhatsApp providers, which
   * stay one-at-a-time.
   */
  emailRole?: EmailRole;
  onEmailRoleChange?: (role: EmailRole) => void;
}) {
  const { t, locale } = useI18n();
  const isResend = provider === "resend";
  const senders = useOptionListItemsByCode(RESEND_SENDER_LIST_CODE, isResend);
  const [senderDraft, setSenderDraft] = useState<string | null>(null);
  const currentSender = senderDraft ?? fromEmail ?? "";
  // Held as a draft rather than written on change. `ImageSourceInput` fires
  // `onChange` for every keystroke in its URL box, so saving there would start a
  // mutation per character and let an out-of-order response overwrite the final
  // URL with a half-typed one.
  const [logoDraft, setLogoDraft] = useState<string | null>(null);
  const currentLogo = logoDraft ?? emailLogoUrl ?? "";
  const fields = providerFieldKeys(provider);
  const valueFor = (key: string) => draft?.[key] ?? configValue(config, key);
  // Every field, saved or unsaved. An edit and a save both need the whole set,
  // because a draft holding only the box that changed would drop the rest.
  const currentDraft = (): Record<string, string> =>
    Object.fromEntries(fields.map((field) => [field.key, valueFor(field.key)]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          {t(`notificationProvider.${provider}`)}
          <div className="flex items-center gap-3">
            {emailRole && onEmailRoleChange ? (
              <Select
                value={emailRole}
                onValueChange={(next) => onEmailRoleChange(next as EmailRole)}
              >
                <SelectTrigger
                  className="h-8 w-32 rounded-xl text-xs font-semibold"
                  aria-label={t("providers.emailRole").replace(
                    "{provider}",
                    t(`notificationProvider.${provider}`),
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary">{t("providers.emailRolePrimary")}</SelectItem>
                  <SelectItem value="fallback">{t("providers.emailRoleFallback")}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <Switch
              checked={isEnabled}
              onCheckedChange={onToggle}
              // The provider name beside it is a sibling text node, not this
              // control's accessible name, so a screen reader would otherwise
              // announce five identical unlabelled switches.
              aria-label={t("providers.enableProvider").replace(
                "{provider}",
                t(`notificationProvider.${provider}`),
              )}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields.map((field) => (
          <div key={field.key} className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:items-center">
            <Label required={field.required} htmlFor={`${provider}-${field.key}`}>
              {t(`providerField.${field.key}`)}
            </Label>
            <Input
              id={`${provider}-${field.key}`}
              dir="ltr"
              placeholder={field.placeholder}
              value={valueFor(field.key)}
              onChange={(event) =>
                onDraftChange({ ...currentDraft(), [field.key]: event.target.value })
              }
            />
          </div>
        ))}

        {isResend ? (
          <>
            <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:items-center">
              <Label htmlFor="resend-from-email">{t("providerField.fromEmail")}</Label>
              <div className="grid gap-1">
                {/* A dropdown rather than free text because Resend verifies a
                    DOMAIN: a typo'd address is refused at send time with an
                    error the operator then has to interpret. The catalogue is
                    admin-editable at Settings -> Lists without a deploy. */}
                <Select value={currentSender || undefined} onValueChange={setSenderDraft}>
                  <SelectTrigger id="resend-from-email" dir="ltr">
                    <SelectValue placeholder={t("providerField.fromEmailPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(senders.data ?? []).map((item) => (
                      <SelectItem key={item.value} value={item.value} dir="ltr">
                        {item.value}
                        {" — "}
                        {locale === "ar" ? item.label_ar : item.label_en}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{t("providerField.fromEmailHint")}</p>
              </div>
            </div>

            <div className="grid gap-1 sm:grid-cols-[12rem_1fr] sm:items-start">
              <Label>{t("providerField.emailLogo")}</Label>
              <ImageSourceInput
                value={currentLogo}
                onChange={setLogoDraft}
                bucket="branding"
                folder="email-logo"
                maxDimension={480}
                uploadHint={t("providerField.emailLogoHint")}
              />
            </div>
          </>
        ) : null}

        <Button
          className="w-full"
          variant="outline"
          disabled={saving}
          onClick={() => {
            // Merged over the stored config rather than replacing it. The form
            // only renders the keys in PROVIDER_CONFIG_SHAPE, and the column
            // permits others — migration 07 seeds `template_namespace_ref` —
            // so saving the draft alone would silently drop whatever this
            // screen does not know how to show.
            const nextConfig = { ...storedConfig(config), ...draftToConfig(currentDraft()) };
            // Validated before the round trip so the admin is told which key is
            // wrong, rather than seeing a database constraint violation.
            const problem = validateProviderConfig(provider, JSON.stringify(nextConfig));
            if (problem) {
              toast.error(problem);
              return;
            }
            onSave({
              config: nextConfig as Json,
              // Only sent when the admin actually picked one, so saving the API
              // key field never clears a sender set elsewhere.
              ...(isResend && senderDraft !== null ? { from_email: senderDraft } : {}),
              ...(isResend && logoDraft !== null ? { email_logo_url: logoDraft || null } : {}),
            });
          }}
        >
          <Save className="size-4" />
          {t("common.save")}
        </Button>
      </CardContent>
    </Card>
  );
}
