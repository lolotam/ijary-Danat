import { useMemo, useState } from "react";
import { Clock, Info, Search, Sparkles } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { LandingCategory } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { searchBrands } from "@/lib/landingBrandVisibility";
import { type BrandRow, gridColsClass, PAGE_SHELL } from "./landingLayout";

interface ShopExplorerProps {
  explorerBrands: BrandRow[] | undefined;
  categoryRows: LandingCategory[] | undefined;
  categoryName: (categoryId: string | null) => string;
  shopColumns: number;
  setSelectedBrand: (brand: BrandRow) => void;
}

/**
 * دليل المتاجر: فلاتر الفئات والبحث وشبكة البطاقات.
 *
 * The search text and the chosen category are this section's own state; the
 * page only needs to know which brand was clicked.
 */
export function ShopExplorer({
  explorerBrands,
  categoryRows,
  categoryName,
  shopColumns,
  setSelectedBrand,
}: ShopExplorerProps) {
  const { t, locale } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  // Search runs over the explorer-visible set, not over every brand, so a shop
  // switched off in the admin form cannot be searched back onto the page.
  const filteredBrands =
    explorerBrands &&
    searchBrands(explorerBrands, { query: searchQuery, categoryId: selectedCategory });

  // Filter chips: "All" plus only the categories that actually have brands the
  // explorer will show — otherwise a chip filters down to zero cards.
  const filterCategories = useMemo(() => {
    const used = new Set((explorerBrands ?? []).map((b) => b.category_id).filter(Boolean));
    return (categoryRows ?? []).filter((c) => used.has(c.id));
  }, [explorerBrands, categoryRows]);

  return (
    <section id="shops" className={`py-24 ${PAGE_SHELL} scroll-mt-20`}>
      <div className="text-center max-w-3xl mx-auto mb-16">
        <span className="flex items-center justify-center gap-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
          <Sparkles className="size-3.5" />
          {t("landingPage.storeDirectory")}
        </span>
        <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground mt-2 mb-4">
          {t("landing.explorer.title")}
        </h2>
        <div className="w-12 h-1 bg-gradient-to-r from-accent/80 to-accent mx-auto mb-6" />
      </div>

      {/* Filters Bar */}
      <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 mb-10 bg-card p-4 rounded-xl border border-border">
        {/* Categories filters */}
        <div className="flex flex-wrap gap-2">
          {[{ id: "all", name_ar: "الكل", name_en: "All" }, ...filterCategories].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              aria-pressed={selectedCategory === cat.id}
              className={`min-h-11 px-5 py-2 rounded-full text-xs font-bold transition-all ${
                selectedCategory === cat.id
                  ? "bg-gradient-to-r from-accent/80 to-accent text-primary-foreground shadow-md"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {locale === "ar" ? cat.name_ar : cat.name_en}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative max-w-xs w-full">
          <Search
            className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder={t("landing.explorer.search")}
            aria-label={t("landing.explorer.search")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-10 bg-muted border-border text-foreground text-xs rounded-full focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className={`grid gap-5 sm:gap-6 ${gridColsClass(shopColumns)}`}>
        {filteredBrands?.length === 0 ? (
          <div className="col-span-full text-center py-12 text-muted-foreground/60 bg-card border border-border rounded-xl">
            <Info className="h-8 w-8 text-accent mx-auto mb-3" />
            <p className="text-sm">{t("landing.explorer.empty")}</p>
          </div>
        ) : (
          filteredBrands?.map((brand) => (
            <button
              type="button"
              key={brand.id}
              onClick={() => setSelectedBrand(brand)}
              className="group bg-card rounded-xl border border-border p-4 sm:p-5 flex flex-col text-center cursor-pointer transition-all hover:border-accent/30 hover:-translate-y-1 motion-reduce:hover:translate-y-0 shadow-md hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring overflow-hidden"
            >
              <div className="aspect-square w-full rounded-lg bg-muted p-1 flex items-center justify-center overflow-hidden transition-transform group-hover:scale-[1.02] motion-reduce:group-hover:scale-100">
                {(() => {
                  const row = brand as BrandRow;
                  const coverSrc = row.cover?.storage_path;
                  const logoSrc = row.logo?.storage_path;
                  if (coverSrc) {
                    return (
                      <img
                        src={coverSrc}
                        alt={brand.name_en}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    );
                  }
                  if (logoSrc) {
                    return (
                      <img
                        src={logoSrc}
                        alt={brand.name_en}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain"
                      />
                    );
                  }
                  return (
                    <span className="text-base font-bold text-muted-foreground px-4">
                      {brand.name_en}
                    </span>
                  );
                })()}
              </div>
              <div className="mt-4 px-1">
                <h3 className="font-bold text-foreground text-lg group-hover:text-accent transition-colors mb-1">
                  {locale === "ar" ? brand.name_ar : brand.name_en}
                </h3>
                <p className="text-xs bg-muted text-accent px-2.5 py-0.5 rounded-full inline-block font-bold">
                  {categoryName(brand.category_id)}
                </p>
              </div>
              <div className="mt-4 w-full border-t border-border pt-4 text-xs text-muted-foreground flex items-center justify-center gap-1">
                <Clock className="h-3 w-3" />
                <span dir="ltr">
                  {String((brand.opening_hours_json as any)?.daily || "08:00 AM - 10:00 PM")}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
