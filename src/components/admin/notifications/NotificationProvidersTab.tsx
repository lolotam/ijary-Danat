import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";

import { ProviderConfigCard } from "@/components/admin/ProviderConfigCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { useCompany, useUpdateCompany } from "@/hooks/useCompany";
import type { useProviderConfigs, useUpdateProviderConfig } from "@/hooks/useProviderConfigs";
import { useI18n } from "@/i18n/provider";
import { emailRolePromotionTarget, type EmailRole } from "@/lib/providers/emailRole";
import { providerChannel } from "@/lib/providers/providerChannel";

/**
 * تبويب مزوّدي الإرسال مقسّماً حسب القناة (البريد / واتساب) مع بطاقة إعداد لكل مزوّد.
 *
 * The queries, mutations and unsaved drafts stay owned by the page and arrive
 * as props: Radix unmounts an inactive tab, and a draft or an in-flight save's
 * toast must survive the admin switching tabs.
 */
export function NotificationProvidersTab({
  providers,
  company,
  updateProvider,
  updateCompany,
  providerDrafts,
  setProviderDrafts,
}: {
  providers: ReturnType<typeof useProviderConfigs>;
  company: ReturnType<typeof useCompany>;
  updateProvider: ReturnType<typeof useUpdateProviderConfig>;
  updateCompany: ReturnType<typeof useUpdateCompany>;
  providerDrafts: Record<string, Record<string, string>>;
  setProviderDrafts: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
}) {
  const { t } = useI18n();
  const configs = providers.data ?? [];
  const emailProviderIds = configs
    .filter((provider) => providerChannel(provider.provider) === "email")
    .map((provider) => provider.id);
  const setEmailRole = (id: string, role: EmailRole) => {
    const target = emailRolePromotionTarget(emailProviderIds, id, role);
    if (!target) return;
    updateProvider.mutate(
      { id: target, updates: { is_primary: true } },
      {
        onError: (error) => toast.error(error.message),
        onSuccess: () => void providers.refetch(),
      },
    );
  };
  return (
    <Tabs defaultValue="email" className="space-y-4">
      <TabsList>
        <TabsTrigger value="email">{t("providers.channelEmail")}</TabsTrigger>
        <TabsTrigger value="whatsapp">{t("providers.channelWhatsapp")}</TabsTrigger>
      </TabsList>

      {(["email", "whatsapp"] as const).map((channel) => (
        <TabsContent key={channel} value={channel} className="grid gap-4 lg:grid-cols-2">
          {configs
            .filter((provider) => providerChannel(provider.provider) === channel)
            .map((provider) => (
              <ProviderConfigCard
                key={provider.id}
                provider={provider.provider}
                config={provider.config}
                isEnabled={provider.is_enabled}
                fromEmail={provider.from_email}
                emailLogoUrl={company.data?.email_logo_url ?? ""}
                saving={updateProvider.isPending}
                emailRole={
                  channel === "email" ? (provider.is_primary ? "primary" : "fallback") : undefined
                }
                onEmailRoleChange={
                  channel === "email" ? (role) => setEmailRole(provider.id, role) : undefined
                }
                draft={providerDrafts[provider.id]}
                onDraftChange={(next) =>
                  setProviderDrafts((current) => ({ ...current, [provider.id]: next }))
                }
                onToggle={(checked) =>
                  updateProvider.mutate(
                    { id: provider.id, updates: { is_enabled: checked } },
                    {
                      onError: (error) => toast.error(error.message),
                      onSuccess: () => {
                        // Email providers may both be on since migration 225;
                        // only WhatsApp still switches the others off.
                        if (!checked || channel === "email") return;
                        toast.message(t("providers.exclusiveWhatsapp"));
                        void providers.refetch();
                      },
                    },
                  )
                }
                onSave={({ email_logo_url: emailLogo, ...updates }) => {
                  // The logo lives on `companies`, the rest on
                  // `provider_configs`, so one Save writes two tables.
                  if (emailLogo !== undefined && company.data) {
                    updateCompany.mutate(
                      { id: company.data.id, updates: { email_logo_url: emailLogo } },
                      { onError: (error) => toast.error(error.message) },
                    );
                  }
                  updateProvider.mutate(
                    { id: provider.id, updates },
                    {
                      onError: (error) => toast.error(error.message),
                      onSuccess: () => toast.success(t("common.saved")),
                    },
                  );
                }}
              />
            ))}
        </TabsContent>
      ))}
    </Tabs>
  );
}
