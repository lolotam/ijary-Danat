/**
 * وصف الصورتين اللتين يملكهما كل متجر: نسبة العرض إلى الارتفاع، وطريقة الملاءمة،
 * ومفاتيح الترجمة — مصدر واحد يستعمله نموذج الإدارة ولوحة المستأجر معاً.
 *
 * The ratios are not a design preference, they are what the public landing page
 * already renders. The brands-carousel tile is `aspect-video` with
 * `object-contain` (`src/routes/index.tsx:174`) and the shop-explorer card is
 * `aspect-square` with `object-cover` (`src/routes/index.tsx:1076`). A tenant
 * who uploads a square logo gets it letterboxed in the carousel, and a wide
 * card image gets its sides cropped off in the explorer — silently, and only
 * visible once it is already on the public site.
 *
 * So both forms state the ratio, and the portal previews the upload inside a
 * box of that exact shape with the landing page's own object-fit. The crop
 * becomes visible before the save rather than after it.
 *
 * These values are duplicated from `index.tsx` rather than imported into it:
 * the landing page owns its own markup, and a shared Tailwind class string
 * would couple a public page's layout to a form's helper. When the carousel or
 * the card changes shape, this file changes with it — that is the one thing to
 * remember, and the reason the line numbers are named above.
 */

export type ShopImageKind = "logo" | "cover";

export interface ShopImageField {
  /**
   * Rendered verbatim in both locales. Digits and a colon carry no language,
   * so this deliberately is not a translation key.
   */
  ratioLabel: string;
  /** Tailwind aspect-ratio utility for the placeholder and the preview box. */
  boxClassName: string;
  /** Mirrors how the landing page fits this image into that box. */
  fitClassName: string;
  labelKey: string;
  hintKey: string;
  /** Shown inside the empty placeholder before anything is uploaded. */
  emptyKey: string;
  /** Toast after a successful upload. */
  uploadedKey: string;
}

export const SHOP_IMAGE_FIELDS: Readonly<Record<ShopImageKind, ShopImageField>> = {
  logo: {
    ratioLabel: "16:9",
    boxClassName: "aspect-video",
    fitClassName: "object-contain",
    labelKey: "portal.shop.logo",
    hintKey: "portal.shop.logoHint",
    emptyKey: "portal.shop.logoEmpty",
    uploadedKey: "portal.shop.logoUploaded",
  },
  cover: {
    ratioLabel: "1:1",
    boxClassName: "aspect-square",
    fitClassName: "object-cover",
    labelKey: "portal.shop.cover",
    hintKey: "portal.shop.coverHint",
    emptyKey: "portal.shop.coverEmpty",
    uploadedKey: "portal.shop.coverUploaded",
  },
};
