/**
 * أقل ما يحتاجه فرز المحلات من صف المحل، حتى تبقى الدوال قابلة للاختبار بلا استعلام.
 *
 * The two visibility columns are optional here, not `boolean` as the table
 * declares them, because these functions also run over rows that predate
 * migration 172 — a TanStack Query cache filled by the previous bundle, or a
 * browser tab left open across the deploy.
 */
export interface LandingBrandRow {
  name_ar: string;
  name_en: string;
  name_original: string;
  category_id: string | null;
  show_in_brands_marquee?: boolean | null;
  show_in_shop_explorer?: boolean | null;
}

/**
 * المحلات التي يعرضها شريط العلامات التجارية المتحرك في الصفحة الرئيسية.
 *
 * A per-shop override that sits underneath the global `brands_marquee` section
 * switch: the section switch hides the whole band, this hides one shop from it.
 * Independent of the explorer — a shop can be in the marquee and out of the
 * directory, or the reverse.
 *
 * Only an explicit `false` hides. A missing column reads as visible so a row
 * cached from before migration 172 keeps its place instead of vanishing from
 * the public page the moment the new bundle loads.
 */
export function filterMarqueeBrands<T extends LandingBrandRow>(brands: readonly T[]): T[] {
  return brands.filter((brand) => brand.show_in_brands_marquee !== false);
}

/** المحلات التي يعرضها دليل «استكشف محلاتنا» — بنفس قاعدة الشريط وبعمود مستقل عنه. */
export function filterExplorerBrands<T extends LandingBrandRow>(brands: readonly T[]): T[] {
  return brands.filter((brand) => brand.show_in_shop_explorer !== false);
}

/** معايير بحث الدليل كما تصل من مربع البحث وأزرار التصنيف. */
export interface BrandSearchCriteria {
  query: string;
  /** "all" = كل التصنيفات؛ وإلا فهو معرّف تصنيف. */
  categoryId: string;
}

/**
 * يبحث داخل مجموعة محلات معروضة بالفعل، بالاسم وبالتصنيف.
 *
 * Kept apart from the visibility filters rather than folded into one pass: the
 * category chips are built from the visible set *before* the search runs, so a
 * chip stays on screen while its cards are searched away.
 *
 * `category_id` is a uuid FK to `building_categories`, so the comparison is by
 * id and never by code.
 */
export function searchBrands<T extends LandingBrandRow>(
  brands: readonly T[],
  { query, categoryId }: BrandSearchCriteria,
): T[] {
  const q = query.trim().toLowerCase();
  return brands.filter((brand) => {
    const matchesSearch =
      brand.name_ar.toLowerCase().includes(q) ||
      brand.name_en.toLowerCase().includes(q) ||
      brand.name_original.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    return categoryId === "all" || brand.category_id === categoryId;
  });
}
