import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  directionFor,
  t as translate,
  type Locale,
} from "./dictionary";

interface I18nContextValue {
  locale: Locale;
  dir: "rtl" | "ltr";
  t: (key: string) => string;
  setLocale: (locale: Locale) => void;
  toggle: () => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // Read stored preference after hydration.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && (LOCALES as string[]).includes(stored)) {
      setLocaleState(stored as Locale);
    }
  }, []);

  // Sync <html lang> and <html dir> whenever locale changes on the client.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("lang", locale);
    document.documentElement.setAttribute("dir", directionFor(locale));
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      dir: directionFor(locale),
      t: (key: string) => translate(locale, key),
      setLocale,
      toggle: () => setLocale(locale === "ar" ? "en" : "ar"),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useOptionalI18n(): I18nContextValue | null {
  return useContext(I18nContext);
}

export function useI18n(): I18nContextValue {
  const ctx = useOptionalI18n();
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
