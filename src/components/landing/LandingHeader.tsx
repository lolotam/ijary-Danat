import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";

import { useAuth } from "@/auth/AuthProvider";
import { BrandLogo } from "@/components/BrandLogo";
import { useTheme } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import type { visibleLandingNavigation } from "@/lib/landingNavigation";
import { PAGE_SHELL } from "./landingLayout";

interface LandingHeaderProps {
  navigationItems: ReturnType<typeof visibleLandingNavigation>;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}

/**
 * الشريط العلوي الثابت: الشعار والتنقل وتبديل اللغة والدخول، وقائمة الجوال.
 *
 * `mobileMenuOpen` stays in the page because the page also locks body scroll
 * while the menu is open; the scroll-tracking state is this header's alone.
 */
export function LandingHeader({
  navigationItems,
  mobileMenuOpen,
  setMobileMenuOpen,
}: LandingHeaderProps) {
  const { t, toggle } = useI18n();
  const { theme } = useTheme();
  const auth = useAuth();
  const isDark = theme === "dark";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    /** يتتبّع تمرير الصفحة لتبديل مظهر الشريط العلوي. */
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };

    // Registered passive: the handler never calls preventDefault, and saying so
    // lets the browser commit the scroll frame without waiting on it.
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-300 ${
        scrolled
          ? "bg-background/90 backdrop-blur-md border-b border-border/60 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 shadow-lg"
          : "bg-transparent pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5"
      }`}
    >
      <div className={`flex items-center justify-between ${PAGE_SHELL}`}>
        <BrandLogo
          name={t("landingPage.danatFuture")}
          subName={t("landingPage.realEstatePlatform")}
          onDark={isDark}
        />

        {/* Desktop Nav — centered, bold */}
        <nav
          className="hidden flex-1 items-center justify-center gap-8 text-sm font-semibold tracking-wide md:flex"
          aria-label={t("landingPage.primaryNavigation")}
        >
          {navigationItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-muted-foreground transition-colors hover:text-accent focus-visible:text-accent"
            >
              {t(item.labelKey)}
            </a>
          ))}
        </nav>

        {/* Desktop actions — right-aligned. The mobile sidebar below carries
            its own login/logout, so everything here stays behind `md:`. */}
        <div className="hidden items-center justify-end gap-3 md:flex">
          <ThemeToggle />
          <button
            type="button"
            onClick={toggle}
            className="min-h-10 rounded-full border border-border bg-card px-4 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("nav.language")}
          </button>
          {/* Mirrors the mobile sidebar rather than always reading "Login":
              a signed-in tenant seeing Login here and Logout there, on the
              same page, is the state this used to be in. */}
          {auth.user ? (
            <Button variant="outline" onClick={() => void auth.signOut()}>
              {t("nav.logout")}
            </Button>
          ) : (
            <Button asChild className="bg-[#d4af37] text-[#171204]">
              <Link to="/portal/auth">{t("nav.login")}</Link>
            </Button>
          )}
        </div>

        <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <DialogTrigger asChild>
            <button
              className="grid size-11 place-items-center rounded-full text-accent transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
              title={t("landingPage.openMenu")}
              aria-label={t("landingPage.openMenu")}
              aria-expanded={mobileMenuOpen}
            >
              <Menu className="h-6 w-6" />
            </button>
          </DialogTrigger>
          <DialogContent className="inset-0 flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col items-center justify-center gap-7 rounded-none border-0 bg-background px-6 text-center md:hidden">
            <DialogHeader className="sr-only">
              <DialogTitle>{t("landingPage.primaryMenu")}</DialogTitle>
              <DialogDescription>{t("landingPage.mainWebsiteLinks")}</DialogDescription>
            </DialogHeader>
            {navigationItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="text-xl font-semibold text-foreground transition-colors hover:text-accent focus-visible:text-accent"
              >
                {t(item.labelKey)}
              </a>
            ))}
            <div className="flex items-center gap-4">
              <ThemeToggle />
              <Button
                variant="outline"
                onClick={() => {
                  toggle();
                  setMobileMenuOpen(false);
                }}
              >
                {t("nav.language")}
              </Button>
            </div>
            {/* Login/Logout at the bottom of the mobile sidebar.
                Logged-in users see Logout; logged-out users see Login. */}
            <div className="mt-auto pt-4">
              {auth.user ? (
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full max-w-xs"
                  onClick={async () => {
                    await auth.signOut();
                    setMobileMenuOpen(false);
                  }}
                >
                  {t("nav.logout")}
                </Button>
              ) : (
                <Button asChild size="lg" className="w-full max-w-xs bg-[#d4af37] text-[#171204]">
                  <Link to="/portal/auth" onClick={() => setMobileMenuOpen(false)}>
                    {t("nav.login")}
                  </Link>
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </header>
  );
}
