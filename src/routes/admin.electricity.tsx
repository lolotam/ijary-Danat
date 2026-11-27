import { createFileRoute } from "@tanstack/react-router";
import { guardModuleRoute } from "@/company/requireModule";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { ChargesTab } from "@/components/admin/electricity/ChargesTab";
import { MetersTab } from "@/components/admin/electricity/MetersTab";
import { ReadingsTab } from "@/components/admin/electricity/ReadingsTab";
import { TariffsTab } from "@/components/admin/electricity/TariffsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { PERMISSIONS } from "@/lib/permissions";

export const Route = createFileRoute("/admin/electricity")({
  beforeLoad: () => guardModuleRoute("electricity"),
  component: ElectricityPage,
});

function ElectricityPage() {
  const { t } = useI18n();
  const permissions = usePermissions();

  if (!permissions.can(PERMISSIONS.ELECTRICITY_READ)) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  return (
    <div className="space-y-6">
      <ModuleHeader title={t("electricity.title")} subtitle={t("electricity.subtitle")} />
      <Tabs defaultValue="meters" className="space-y-4">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="meters">{t("electricity.tabs.meters")}</TabsTrigger>
          <TabsTrigger value="readings">{t("electricity.tabs.readings")}</TabsTrigger>
          <TabsTrigger value="charges">{t("electricity.tabs.charges")}</TabsTrigger>
          {permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS) && (
            <TabsTrigger value="tariffs">{t("electricity.tabs.tariffs")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="meters">
          <MetersTab />
        </TabsContent>
        <TabsContent value="readings">
          <ReadingsTab />
        </TabsContent>
        <TabsContent value="charges">
          <ChargesTab />
        </TabsContent>
        {permissions.can(PERMISSIONS.ELECTRICITY_TARIFFS) && (
          <TabsContent value="tariffs">
            <TariffsTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
