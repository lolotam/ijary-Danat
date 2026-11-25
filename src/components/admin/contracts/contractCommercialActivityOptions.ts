import {
  mapCommercialActivityOptions,
  type CatalogueOptionItem,
} from "@/lib/commercialActivityOptions";
import { NO_COMMERCIAL_ACTIVITY } from "@/lib/contractForm";

/**
 * يبني خيارات النشاط التجاري للعقد: «بلا» أولاً، ثم القائمة، ثم القيمة الحالية إن غابت عنها.
 *
 * The stored value is appended when the catalogue no longer lists it, so an
 * activity removed in Settings → Lists still shows on the contract that carries
 * it instead of the select rendering blank.
 */
export function contractCommercialActivityOptions(
  items: readonly CatalogueOptionItem[],
  currentValue: string | null | undefined,
  locale: "ar" | "en",
  noneLabel: string,
): Array<{ value: string; label: string }> {
  const mapped = mapCommercialActivityOptions(items, locale);
  if (
    currentValue &&
    currentValue !== NO_COMMERCIAL_ACTIVITY &&
    !mapped.some((option) => option.value === currentValue)
  ) {
    mapped.push({
      value: currentValue,
      label: currentValue,
    });
  }
  return [{ value: NO_COMMERCIAL_ACTIVITY, label: noneLabel }, ...mapped];
}
