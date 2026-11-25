import { createFileRoute } from "@tanstack/react-router";

import { ShopDetailsPanel } from "@/components/portal/ShopDetailsPanel";

export const Route = createFileRoute("/portal/shop")({
  component: PortalShopRoute,
});

/**
 * صفحة متجري — بوابة المستأجر.
 *
 * المحتوى نفسه يعتني بحالة "لا يوجد محل": لا يعيد التوجيه، بل يعرض رسالة
 * فارغة، لأن إخفاء رابط التنقل هو عرض فقط وليس تحكماً بالوصول.
 */
function PortalShopRoute() {
  return <ShopDetailsPanel />;
}
