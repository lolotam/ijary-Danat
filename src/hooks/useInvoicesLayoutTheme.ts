import { useEffect, useState } from "react";

export type InvoicesLayoutTheme = "modern" | "classic";

const THEME_STORAGE_KEY = "danat.invoices.layout_theme";

/**
 * خطاف مخصص لإدارة مظهر صفحة الفواتير الشهرية وحفظ خيار المستخدم محليًا.
 *
 * Manages the layout theme preference (modern vs classic) for the monthly
 * invoices overview, persisting the admin's preference in localStorage.
 */
export function useInvoicesLayoutTheme() {
  const [layoutTheme, setLayoutThemeState] = useState<InvoicesLayoutTheme>("modern");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "modern" || stored === "classic") {
      setLayoutThemeState(stored);
    }
  }, []);

  const setLayoutTheme = (next: InvoicesLayoutTheme) => {
    setLayoutThemeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  };

  return {
    layoutTheme,
    setLayoutTheme,
  };
}
