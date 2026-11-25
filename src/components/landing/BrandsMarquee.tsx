import { useI18n } from "@/i18n/provider";
import { type BrandRow, PAGE_SHELL } from "./landingLayout";

interface BrandsMarqueeProps {
  marqueeBrands: BrandRow[];
  setSelectedBrand: (brand: BrandRow) => void;
}

/**
 * بطاقة شعار واحدة في الشريط المتحرك.
 *
 * `tabbable` is false on the duplicated copy that makes the loop seamless, so
 * keyboard users do not tab through every brand twice.
 */
function BrandLogoCard({
  brand,
  locale,
  onSelect,
  tabbable = true,
}: {
  brand: BrandRow;
  locale: string;
  onSelect: (brand: BrandRow) => void;
  tabbable?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(brand)}
      className="flex flex-col items-center justify-center shrink-0 cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      {/* 16:9 tile at 2× prior width; logos contained so wordmarks stay legible. */}
      <div className="aspect-video w-[22rem] rounded-lg bg-card border border-border p-4 flex items-center justify-center transition-all group-hover:border-accent/40 group-hover:shadow-lg">
        {brand.logo_media_id && brand.logo ? (
          <img
            src={brand.logo.storage_path}
            alt={brand.name_en}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain filter brightness-95 dark:brightness-90 group-hover:brightness-100 dark:group-hover:brightness-95 transition-all"
          />
        ) : (
          <span className="text-sm font-bold text-muted-foreground">{brand.name_en}</span>
        )}
      </div>
      <span className="text-sm font-bold text-muted-foreground mt-2 group-hover:text-accent transition-colors">
        {locale === "ar" ? brand.name_ar : brand.name_en}
      </span>
    </button>
  );
}

/**
 * شريط شعارات المحلات المتحرك بلا نهاية.
 */
export function BrandsMarquee({ marqueeBrands, setSelectedBrand }: BrandsMarqueeProps) {
  const { t, locale } = useI18n();

  return (
    <section className="bg-card py-16 border-y border-border overflow-hidden">
      <div className={`${PAGE_SHELL} mb-8 text-center`}>
        <h3 className="mb-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
          {t("landing.brands.title")}
        </h3>
      </div>

      {/* Two identical copies each translate by their own width for a
        seamless infinite loop. The strip is forced LTR so translateX
        math is stable; Arabic reverses the animation direction instead.
        Hover pauses; reduced-motion swaps to a manual scroll strip. */}
      <div
        className="group relative flex w-full overflow-x-hidden motion-reduce:overflow-x-auto"
        dir="ltr"
      >
        {[0, 1].map((copy) => (
          <div
            key={copy}
            aria-hidden={copy === 1}
            inert={copy === 1}
            className={`flex shrink-0 items-start gap-20 pe-20 py-4 animate-marquee motion-reduce:animate-none group-hover:[animation-play-state:paused] ${
              copy === 1 ? "motion-reduce:hidden" : ""
            }`}
            style={{ animationDirection: t("landingPage.normal") }}
          >
            {marqueeBrands.map((brand) => (
              <BrandLogoCard
                key={copy === 0 ? brand.id : `${brand.id}-dup`}
                brand={brand as BrandRow}
                locale={locale}
                onSelect={setSelectedBrand}
                tabbable={copy === 0}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
