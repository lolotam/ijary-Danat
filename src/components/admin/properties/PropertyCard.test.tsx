import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PropertyListItem } from "@/hooks/useProperties";
import { dictionaries } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";

import { PropertyCard } from "./PropertyCard";

/**
 * عقار وهمي يكفي لرسم البطاقة دون الاعتماد على شبكة أو كتالوج.
 */
function sampleProperty(overrides: Partial<PropertyListItem> = {}): PropertyListItem {
  return {
    id: "prop-a",
    code: "PROP-001",
    name_ar: "مبنى أ",
    name_en: "Building A",
    status: "active",
    type: "compound",
    area: 100,
    image_url: null,
    occupiedUnits: 1,
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
    ...overrides,
  };
}

/**
 * يرسم البطاقة داخل مزوّد الترجمة لأن أزرار الجدول ومفتاح الإشغال يستدعيان useI18n.
 */
function renderCard(
  props: Partial<Parameters<typeof PropertyCard>[0]> & {
    monthlyTotal?: number;
    totalsError?: boolean;
  },
): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <PropertyCard
        property={sampleProperty()}
        monthlyTotal={props.monthlyTotal}
        totalsError={props.totalsError ?? false}
        locale="ar"
        t={(key) => dictionaries.ar[key] ?? key}
        typeLabel="مجمّع"
        canUpdate
        canDelete
        onOpen={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("PropertyCard monthly pill", () => {
  it("renders the collectible amount inside the emerald pill", () => {
    const markup = renderCard({ monthlyTotal: 750 });
    expect(markup).toContain('data-testid="monthly-pill"');
    expect(markup).toContain(dictionaries.ar["properties.monthlyToCollect"]);
    expect(markup).toContain(formatKwd(750, "ar"));
  });

  it("renders a zero pill rather than hiding it", () => {
    const markup = renderCard({ monthlyTotal: 0 });
    expect(markup).toContain('data-testid="monthly-pill"');
    expect(markup).toContain(formatKwd(0, "ar"));
  });

  it("renders no pill while totals are still loading", () => {
    const markup = renderCard({ monthlyTotal: undefined, totalsError: false });
    expect(markup).not.toContain('data-testid="monthly-pill"');
    expect(markup).not.toContain(dictionaries.ar["common.error"]);
  });

  it("renders the error line and no pill when the totals read failed", () => {
    const markup = renderCard({ monthlyTotal: undefined, totalsError: true });
    expect(markup).not.toContain('data-testid="monthly-pill"');
    expect(markup).toContain(dictionaries.ar["common.error"]);
  });
});
