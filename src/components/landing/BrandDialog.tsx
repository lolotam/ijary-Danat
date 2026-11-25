import { Clock, Instagram, Phone } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import { type BrandRow, brandCardImage } from "./landingLayout";

interface BrandDialogProps {
  selectedBrand: BrandRow | null;
  setSelectedBrand: (brand: BrandRow | null) => void;
  categoryName: (categoryId: string | null) => string;
}

/**
 * نافذة تفاصيل المحل السريعة: الصورة والفئة والوصف والساعات والتواصل.
 */
export function BrandDialog({ selectedBrand, setSelectedBrand, categoryName }: BrandDialogProps) {
  const { t, locale } = useI18n();

  return (
    <Dialog open={selectedBrand !== null} onOpenChange={(open) => !open && setSelectedBrand(null)}>
      {selectedBrand && (
        <DialogContent className="max-w-md bg-background border border-border text-foreground">
          <DialogHeader>
            <div className="flex items-center gap-4 mb-4">
              <div className="h-16 w-24 rounded bg-muted p-2 flex items-center justify-center overflow-hidden">
                {(() => {
                  const row = selectedBrand as BrandRow;
                  const src = brandCardImage(row);
                  if (!src) {
                    return <span className="text-xs font-bold">{selectedBrand.name_en}</span>;
                  }
                  return (
                    <img
                      src={src}
                      alt={selectedBrand.name_en}
                      decoding="async"
                      fetchPriority="high"
                      className={`max-h-full max-w-full ${row.cover?.storage_path ? "object-cover" : "object-contain"}`}
                    />
                  );
                })()}
              </div>
              <div>
                <DialogTitle className="text-xl font-bold text-foreground">
                  {locale === "ar" ? selectedBrand.name_ar : selectedBrand.name_en}
                </DialogTitle>
                <p className="text-[10px] bg-muted text-accent px-2.5 py-0.5 rounded-full inline-block font-bold mt-1">
                  {categoryName(selectedBrand.category_id)}
                </p>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 text-sm mt-2 border-t border-border pt-4">
            <p className="text-muted-foreground leading-relaxed font-medium">
              {locale === "ar" ? selectedBrand.description_ar : selectedBrand.description_en}
            </p>

            <div className="space-y-2.5 text-xs text-muted-foreground/80 pt-2">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-accent" />
                <span>
                  <strong>{t("landingPage.hours")}</strong>{" "}
                  {String(
                    (selectedBrand.opening_hours_json as any)?.daily || "08:00 AM - 10:00 PM",
                  )}
                </span>
              </div>
              {selectedBrand.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-accent" />
                  <span>
                    <strong>{t("landingPage.phone")}</strong>{" "}
                    <a
                      href={`tel:${selectedBrand.phone}`}
                      className="hover:text-accent hover:underline"
                    >
                      <LtrText>{selectedBrand.phone}</LtrText>
                    </a>
                  </span>
                </div>
              )}
              {selectedBrand.instagram_url && (
                <div className="flex items-center gap-2">
                  <Instagram className="h-4 w-4 text-accent" />
                  <span>
                    <strong>Instagram:</strong>{" "}
                    <a
                      href={selectedBrand.instagram_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      @{selectedBrand.instagram_url.split("/").pop()}
                    </a>
                  </span>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
