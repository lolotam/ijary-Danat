import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { PropertyCards } from "@/components/admin/properties/PropertyCards";
import { propertyMonthlyTotalsQuery, type PropertyListItem } from "@/hooks/useProperties";
import { currentPeriodStart } from "@/lib/periodStart";
import { I18nProvider } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async () => ({
      data: [{ property_id: "prop-a", monthly_total: "750.000" }],
      error: null,
    }),
  },
}));

/**
 * عقار وهمي لمعرّف معيّن — الحقول الأخرى ثابتة لأن الاختبار يُعنى بالحبة فقط.
 */
function building(id: string): PropertyListItem {
  return {
    id,
    code: id === "prop-a" ? "PROP-001" : "PROP-002",
    name_ar: id,
    name_en: id,
    status: "active",
    type: "compound",
    area: null,
    image_url: null,
    occupiedUnits: 0,
    vacantUnits: 1,
    address_ar: null,
    address_en: null,
    company_id: null,
    created_at: "2026-01-01T00:00:00Z",
    description_ar: null,
    description_en: null,
    floor_count: null,
    location_url: null,
    paci_no: null,
    unit_count: null,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * يرسم شبكة الصفحة الحقيقية باستعلام محمّل من حدّ Supabase لا بخريطة مصطنعة.
 */
function renderCards(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <PropertyCards
          properties={[building("prop-a"), building("prop-b")]}
          canRead
          canUpdate={false}
          canDelete={false}
          typeLabel={() => "مجمّع"}
          onOpen={() => undefined}
          onEdit={() => undefined}
          onDelete={() => undefined}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("admin properties cards — monthly totals mapping", () => {
  it("gives the building missing from a successful RPC result a zero pill", async () => {
    const queryClient = new QueryClient();
    try {
      const periodStart = currentPeriodStart();
      await queryClient.fetchQuery({
        queryKey: ["property-monthly-totals", periodStart],
        queryFn: propertyMonthlyTotalsQuery(periodStart),
      });
      const markup = renderCards(queryClient);
      expect(markup).toContain(formatKwd(750, "ar"));
      expect(markup).toContain(formatKwd(0, "ar"));
      expect(markup.match(/data-testid="monthly-pill"/g)?.length).toBe(2);
      expect(markup.match(/disabled=""/g)).toHaveLength(4);
    } finally {
      queryClient.clear();
    }
  });
});
