import { createFileRoute } from "@tanstack/react-router";

import { GatewayLaunchPanel } from "@/components/platform/GatewayLaunchPanel";
import { useI18n } from "@/i18n/provider";

export const Route = createFileRoute("/platform/gateways")({
  ssr: false,
  component: PlatformGatewaysPage,
});

/**
 * شاشة إدارة إطلاق بوابات الدفع في الوضع الفعلي على مستوى المنصة (SC-012).
 */
export function PlatformGatewaysPage() {
  const { t } = useI18n();

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t("platformGateways.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("platformGateways.subtitle")}</p>
      </header>

      <GatewayLaunchPanel />
    </section>
  );
}
