import { useEffect, useState } from "react";
import {
  Building,
  Edit2,
  Globe,
  Image as ImageIcon,
  Instagram,
  LayoutGrid,
  Rows3,
  Trash2,
} from "lucide-react";

import { PreviewableImage } from "@/components/admin/ImagePreviewDialog";
import { CardActionsMenu } from "@/components/admin/landing-page/CardActionsMenu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CommercialBrand } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { joinLocalizedList } from "@/lib/contractUnits";

export type BrandRow = CommercialBrand & {
  logo?: { storage_path: string } | null;
  cover?: { storage_path: string } | null;
};

type ShopsView = "rows" | "cards";

const VIEW_STORAGE_KEY = "danat.landing.shops_view";

/**
 * يضيف https:// عندما تُلصق القيمة بدون بروتوكول.
 *
 * Staff often paste instagram.com/name or example.com; a bare href would
 * resolve against the admin origin.
 */
function hrefWithProtocol(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** أقصى عدد عقود تُعرض بالاسم قبل الاختصار إلى عدّاد. */
const CONTRACT_LABEL_LIMIT = 3;

/**
 * يجمع عقود المحل في سطر واحد، مع اختصار الزائد عن الحد إلى عدّاد.
 *
 * A shop can now sit on several leases, and the cell is one truncated line in
 * both the table and the card. Listing all of them would push the useful ones
 * out of view; a bare count would hide which lease a shop is on, which is the
 * question this column exists to answer. Naming the first few and counting the
 * rest keeps both.
 *
 * An id with no label is dropped rather than rendered raw: the options list
 * holds ACTIVE contracts only, so a link to an expired one has no label here
 * and a bare UUID in the cell would read as corruption.
 */
export function joinContractLabels(
  contractIds: readonly string[],
  labelById: Map<string, string>,
  locale: "ar" | "en",
): string {
  const labels = contractIds.map((id) => labelById.get(id)).filter((l): l is string => Boolean(l));
  const shown = labels.slice(0, CONTRACT_LABEL_LIMIT);
  const joined = joinLocalizedList(shown, locale);
  return labels.length > CONTRACT_LABEL_LIMIT
    ? `${joined} +${labels.length - CONTRACT_LABEL_LIMIT}`
    : joined;
}

/**
 * أوقات العمل المخزّنة في `opening_hours_json` كنص للعرض.
 */
function openingHours(brand: BrandRow): string {
  return String((brand.opening_hours_json as { daily?: string } | null)?.daily || "");
}

/**
 * يتذكّر اختيار المستخدم بين عرض الصفوف والبطاقات.
 *
 * Both the server and the client's first render return "rows", and storage is
 * read afterwards in an effect. Reading `localStorage` in the `useState`
 * initialiser would avoid the server exception but still produce a hydration
 * mismatch for anyone whose stored choice is "cards" — the server would emit
 * rows and the client's first paint cards. Same shape as
 * `useInvoicesLayoutTheme`.
 */
function useShopsView() {
  const [view, setViewState] = useState<ShopsView>("rows");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "rows" || stored === "cards") setViewState(stored);
  }, []);

  const setView = (next: ShopsView) => {
    setViewState(next);
    if (typeof window !== "undefined") window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  return { view, setView };
}

/**
 * محلات الصفحة الرئيسية في إعدادات صفحة الهبوط، صفوفًا أو بطاقات.
 *
 * The table was the original view; commit c699dbf replaced it with cards. Both
 * now exist because each answers a different question — the table compares many
 * shops field by field, the cards show one shop's images. Rows is the default
 * because scanning a list is the more common task on this screen.
 */
export function ShopsTable({
  brands,
  contractLabelById,
  contractIdsByBrand,
  onEditBrand,
  onDeleteBrand,
}: {
  brands: BrandRow[] | undefined;
  contractLabelById: Map<string, string>;
  /** عقود كل محل — علاقة كثير-إلى-كثير منذ الترحيل 162، لا عمود واحد. */
  contractIdsByBrand: Map<string, string[]>;
  onEditBrand: (brand: BrandRow) => void;
  onDeleteBrand: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const { view, setView } = useShopsView();

  // `brands` is undefined while loading and [] when empty — gating on
  // falsy-or-empty would flash the empty state on every page load.
  if (Array.isArray(brands) && brands.length === 0) {
    return (
      <EmptyState
        icon={Building}
        title={t("shopsTable.noShopsYet")}
        description={t("shopsTable.clickAddStoreToShow")}
      />
    );
  }

  const label = (brand: BrandRow) => (locale === "ar" ? brand.name_ar : brand.name_en);
  const contractLabel = (brand: BrandRow) =>
    joinContractLabels(contractIdsByBrand.get(brand.id) ?? [], contractLabelById, locale);

  return (
    <div className="space-y-3">
      <ShopsViewToggle view={view} onChange={setView} />
      {view === "cards" ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {brands?.map((brand) => (
            <ShopCard
              key={brand.id}
              brand={brand}
              contractLabel={contractLabel(brand)}
              onEditBrand={onEditBrand}
              onDeleteBrand={onDeleteBrand}
            />
          ))}
        </div>
      ) : (
        <ShopRows
          brands={brands}
          label={label}
          contractLabel={contractLabel}
          onEditBrand={onEditBrand}
          onDeleteBrand={onDeleteBrand}
        />
      )}
    </div>
  );
}

/**
 * مفتاح التبديل بين عرض الصفوف والبطاقات.
 *
 * A radiogroup rather than two independent buttons: the two options are one
 * mutually exclusive choice, and `aria-checked` is what tells a screen reader
 * which view is active — the icon alone conveys nothing.
 */
function ShopsViewToggle({
  view,
  onChange,
}: {
  view: ShopsView;
  onChange: (view: ShopsView) => void;
}) {
  const { t } = useI18n();
  const options: Array<{ value: ShopsView; icon: typeof Rows3; label: string }> = [
    { value: "rows", icon: Rows3, label: t("shopsTable.rows") },
    { value: "cards", icon: LayoutGrid, label: t("shopsTable.cards") },
  ];

  return (
    <div role="radiogroup" aria-label={t("shopsTable.viewMode")} className="flex justify-end gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          role="radio"
          aria-checked={view === option.value}
          aria-label={option.label}
          title={option.label}
          variant={view === option.value ? "secondary" : "ghost"}
          size="sm"
          className="gap-2 pointer-coarse:h-11"
          onClick={() => onChange(option.value)}
        >
          <option.icon className="size-4" />
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * جدول المحلات: عمود لكل حقل، لمقارنة عدة محلات دفعة واحدة.
 *
 * Restored from the pre-c699dbf markup, with two deliberate departures. The two
 * thumbnails are `PreviewableImage` so a row gets the same eye overlay the card
 * gained, and the third column shows the *other* language's name rather than
 * `name_ar` again — the original rendered `name_ar` in both the Name and Arabic
 * Name columns whenever the UI was Arabic, which made the column pair useless
 * in exactly the locale this product is written for.
 */
function ShopRows({
  brands,
  label,
  contractLabel,
  onEditBrand,
  onDeleteBrand,
}: {
  brands: BrandRow[] | undefined;
  label: (brand: BrandRow) => string;
  contractLabel: (brand: BrandRow) => string;
  onEditBrand: (brand: BrandRow) => void;
  onDeleteBrand: (id: string) => void;
}) {
  const { t, locale } = useI18n();

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("shops.logo")}</TableHead>
            <TableHead>{t("shopsTable.card")}</TableHead>
            <TableHead>{t("shopsTable.name")}</TableHead>
            <TableHead>{t("shopsTable.arabicName")}</TableHead>
            <TableHead>{t("shopsTable.phone")}</TableHead>
            <TableHead>{t("shopsTable.website")}</TableHead>
            <TableHead>Instagram</TableHead>
            <TableHead>{t("shopsTable.activeContract")}</TableHead>
            <TableHead>{t("shopsTable.slug")}</TableHead>
            <TableHead>{t("shopsTable.hours")}</TableHead>
            <TableHead>{t("shopsTable.featured")}</TableHead>
            <TableHead>{t("shopsTable.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {brands?.map((brand) => {
            const websiteHref = hrefWithProtocol(brand.website_url ?? "");
            const instagramHref = hrefWithProtocol(brand.instagram_url ?? "");
            const rowContract = contractLabel(brand);
            const primaryName = label(brand);
            const secondaryName = locale === "ar" ? brand.name_en : brand.name_ar;

            return (
              <TableRow key={brand.id}>
                <TableCell>
                  {brand.logo?.storage_path ? (
                    <PreviewableImage
                      url={brand.logo.storage_path}
                      alt={primaryName}
                      className="h-10 w-16"
                      imageClassName="h-10 w-16 object-contain"
                    />
                  ) : (
                    <div
                      className="flex h-10 w-16 items-center justify-center rounded border bg-muted/30"
                      aria-label={t("common.logoPlaceholder")}
                    >
                      <Building className="size-4 text-muted-foreground" />
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {brand.cover?.storage_path ? (
                    <PreviewableImage
                      url={brand.cover.storage_path}
                      alt={primaryName}
                      className="h-10 w-16"
                      imageClassName="h-10 w-16 object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-16 items-center justify-center rounded border bg-muted/30">
                      <ImageIcon className="size-4 text-muted-foreground" />
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-semibold">{primaryName}</TableCell>
                <TableCell className="text-sm">{secondaryName}</TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {brand.phone ? (
                    <a
                      href={`tel:${brand.phone}`}
                      className="text-foreground hover:text-accent hover:underline"
                    >
                      <LtrText>{brand.phone}</LtrText>
                    </a>
                  ) : null}
                </TableCell>
                <TableCell>
                  {websiteHref ? (
                    <a
                      href={websiteHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex size-10 items-center justify-center text-muted-foreground hover:text-accent pointer-coarse:size-11"
                      aria-label={t("shopsTable.website")}
                    >
                      <Globe className="h-4 w-4" />
                    </a>
                  ) : null}
                </TableCell>
                <TableCell>
                  {instagramHref ? (
                    <a
                      href={instagramHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex size-10 items-center justify-center text-muted-foreground hover:text-accent pointer-coarse:size-11"
                      aria-label="Instagram"
                    >
                      <Instagram className="h-4 w-4" />
                    </a>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-[12rem] truncate text-xs" title={rowContract}>
                  {rowContract}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{brand.slug}</TableCell>
                <TableCell className="text-xs">{openingHours(brand)}</TableCell>
                <TableCell>
                  {brand.is_featured ? (
                    <span
                      // A bare span is a generic element, and assistive tech
                      // commonly ignores aria-label on one — without a role the
                      // featured state is simply not announced.
                      role="img"
                      className="inline-block h-2 w-2 rounded-full bg-gold-deep"
                      aria-label={t("shopsTable.featured")}
                    />
                  ) : null}
                </TableCell>
                <TableCell className="flex gap-2">
                  <Button
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                    variant="outline"
                    size="icon"
                    className="pointer-coarse:size-11"
                    onClick={() => onEditBrand(brand)}
                  >
                    <Edit2 className="h-3 w-3" />
                  </Button>
                  <Button
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    variant="destructive"
                    size="icon"
                    className="pointer-coarse:size-11"
                    onClick={() => onDeleteBrand(brand.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * بطاقة محل واحد: الصور والحقول والإجراءات كما كانت في صف الجدول.
 *
 * The text block below the images is centred as one stack. Centring only the
 * heading left the names, slug and hours ragged against it, which read as a
 * layout accident rather than a choice. `text-center` is direction-neutral, so
 * RTL and LTR render identically.
 */
function ShopCard({
  brand,
  contractLabel,
  onEditBrand,
  onDeleteBrand,
}: {
  brand: BrandRow;
  contractLabel: string;
  onEditBrand: (brand: BrandRow) => void;
  onDeleteBrand: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const logoUrl = brand.logo?.storage_path;
  const cardUrl = brand.cover?.storage_path;
  const previewAlt = locale === "ar" ? brand.name_ar : brand.name_en;
  const websiteHref = hrefWithProtocol(brand.website_url ?? "");
  const instagramHref = hrefWithProtocol(brand.instagram_url ?? "");
  const hours = openingHours(brand);

  return (
    <Card className="relative">
      <CardActionsMenu label={t("shopsTable.actions")}>
        <DropdownMenuItem onSelect={() => onEditBrand(brand)}>
          <Edit2 className="size-4" />
          {t("common.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onDeleteBrand(brand.id)}
        >
          <Trash2 className="size-4" />
          {t("common.delete")}
        </DropdownMenuItem>
      </CardActionsMenu>
      {brand.is_featured ? (
        <span
          role="img"
          aria-label={t("shopsTable.featured")}
          className="absolute top-2 start-2 inline-block h-2 w-2 rounded-full bg-gold-deep"
        />
      ) : null}
      <CardContent className="space-y-3 p-4 pt-12">
        {/* Each box carries its landing-page ratio (16:9 carousel logo, 1:1
            explorer card — see src/lib/shopImageFields.ts). Sizing the wrapper
            instead of the img keeps the border hugging the image; an unsized
            wrapper stretched to the grid cell and read as a trailing extension
            beside the letterboxed logo. */}
        <div className="flex h-20 items-center justify-center gap-2">
          {logoUrl ? (
            <PreviewableImage
              url={logoUrl}
              alt={previewAlt}
              className="aspect-video h-full shrink-0"
              imageClassName="h-full w-full object-contain"
            />
          ) : (
            <div
              className="flex aspect-video h-full shrink-0 items-center justify-center rounded border bg-muted/30"
              aria-label={t("common.logoPlaceholder")}
            >
              <Building className="size-4 text-muted-foreground" />
            </div>
          )}
          {cardUrl ? (
            <PreviewableImage
              url={cardUrl}
              alt={previewAlt}
              className="aspect-square h-full shrink-0"
              imageClassName="h-full w-full object-cover"
            />
          ) : (
            <div className="flex aspect-square h-full shrink-0 items-center justify-center rounded border bg-muted/30">
              <ImageIcon className="size-4 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="text-center">
          <h3 className="text-lg font-semibold leading-tight">
            {locale === "ar" ? brand.name_ar : brand.name_en}
          </h3>
          {/* The other language's name, not always the Arabic one. As a table
              these were two labelled columns, so a repeated name read as
              "the Arabic column"; stacked in a card it just looks duplicated. */}
          <p className="text-sm text-muted-foreground">
            {locale === "ar" ? brand.name_en : brand.name_ar}
          </p>
        </div>
        {brand.phone ? (
          <a
            href={`tel:${brand.phone}`}
            className="block text-center text-sm text-foreground hover:text-accent hover:underline"
          >
            <LtrText>{brand.phone}</LtrText>
          </a>
        ) : null}
        <div className="flex items-center justify-center gap-1">
          {websiteHref ? (
            <a
              href={websiteHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-10 items-center justify-center text-muted-foreground hover:text-accent pointer-coarse:size-11"
              aria-label={t("shopsTable.website")}
            >
              <Globe className="h-4 w-4" />
            </a>
          ) : null}
          {instagramHref ? (
            <a
              href={instagramHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex size-10 items-center justify-center text-muted-foreground hover:text-accent pointer-coarse:size-11"
              aria-label="Instagram"
            >
              <Instagram className="h-4 w-4" />
            </a>
          ) : null}
        </div>
        <div className="space-y-1 text-center text-xs text-muted-foreground">
          <p className="max-w-full truncate" title={contractLabel}>
            {contractLabel}
          </p>
          <p>{brand.slug}</p>
          <p>{hours}</p>
        </div>
      </CardContent>
    </Card>
  );
}
