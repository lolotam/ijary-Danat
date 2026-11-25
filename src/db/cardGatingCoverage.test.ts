import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CARD_REGISTRY, type CardPage } from "@/lib/cardRegistry";

/**
 * كل صفحة تحمل بطاقات، والملفات التي قد ترسمها.
 *
 * A page either gates its cards inline or delegates to the shared group, so
 * both files count as a place the gate may legitimately live.
 */
const SOURCES_BY_PAGE: Record<CardPage, string[]> = {
  dashboard: ["src/routes/admin.index.tsx", "src/components/admin/ownedPageKpis.tsx"],
  tenants: ["src/routes/admin.tenants.index.tsx"],
  units: ["src/routes/admin.units.index.tsx", "src/components/admin/ownedPageKpis.tsx"],
  contracts: ["src/routes/admin.contracts.tsx"],
  payments: ["src/routes/admin.payments.tsx"],
  deposits: ["src/routes/admin.deposits.tsx", "src/components/admin/ownedPageKpis.tsx"],
  expenses: ["src/routes/admin.expenses.tsx", "src/components/admin/ownedPageKpis.tsx"],
  portal: [
    "src/routes/portal.tsx",
    "src/routes/portal.index.tsx",
    "src/routes/portal.lease.tsx",
    "src/components/portal/ReminderPopupDialog.tsx",
    "src/components/portal/PortalKpiCards.tsx",
  ],
};

/** يجمع مصادر الصفحة حتى يشمل الفحص البوابات المفوّضة إلى مكوّن مشترك. */
function sourceForPage(page: CardPage): string {
  return SOURCES_BY_PAGE[page]
    .map((file) => readFileSync(resolve(process.cwd(), file), "utf8"))
    .join("\n");
}

/**
 * يثبت أن كل بطاقة في السجلّ محجوبة فعلاً في صفحتها.
 *
 * The Cards control screen renders from CARD_REGISTRY, so a card appears in
 * settings whether or not its page ever consults the config. On 2026-08-14 the
 * four tenants cards were listed in settings and gated nowhere: toggling them
 * did nothing, while every other page worked. Nothing failed — a page that
 * ignores the config looks exactly like a page whose cards are all visible.
 *
 * The delivery plan had assigned that gate to the lane owning the tenants file,
 * but the brief that lane actually received described only its other work. This
 * test exists so the registry and the pages cannot drift again: adding a card id
 * without gating it fails here.
 */
describe("every registry card is actually gated on its page", () => {
  for (const card of CARD_REGISTRY) {
    it(`${card.id} is gated where it renders`, () => {
      const source = sourceForPage(card.page);
      expect(
        source.includes(`isCardVisible("${card.id}")`),
        `${card.id} is offered in Cards control but its page never checks it`,
      ).toBe(true);
    });
  }

  it("names a source file for every page in the registry", () => {
    const pages = new Set(CARD_REGISTRY.map((card) => card.page));
    for (const page of pages) {
      expect(SOURCES_BY_PAGE[page], `no source mapped for page ${page}`).toBeTruthy();
    }
  });
});
