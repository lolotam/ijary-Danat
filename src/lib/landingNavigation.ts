export type LandingSection = "hero" | "about" | "shop_explorer" | "gallery" | "location";

export interface LandingNavigationItem {
  href: string;
  labelKey: string;
  section: LandingSection;
}

const landingNavigation: LandingNavigationItem[] = [
  { href: "#home", labelKey: "nav.home", section: "hero" },
  { href: "#about", labelKey: "landing.nav.about", section: "about" },
  { href: "#shops", labelKey: "landing.nav.shops", section: "shop_explorer" },
  { href: "#gallery", labelKey: "landing.nav.gallery", section: "gallery" },
  { href: "#location", labelKey: "landing.nav.location", section: "location" },
];

export function visibleLandingNavigation(isEnabled: (section: LandingSection) => boolean) {
  return landingNavigation.filter(({ section }) => isEnabled(section));
}
