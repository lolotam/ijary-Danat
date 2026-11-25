// Minimal i18n scaffold: two locales, dictionary lookup, direction helper.
// Kept dependency-free to avoid SSR/i18next hydration pitfalls. Expand as needed.

import { ar } from "./locales/ar";
import { en } from "./locales/en";

export type Locale = "ar" | "en";

export const LOCALES: Locale[] = ["ar", "en"];
export const DEFAULT_LOCALE: Locale = "ar";
export const LOCALE_STORAGE_KEY = "ermp.locale";

export function directionFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

type Dict = Record<string, string>;

export const dictionaries: Record<Locale, Dict> = {
  ar,
  en,
};

export function t(locale: Locale, key: string): string {
  return dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
}

/**
 * يبني دالة ترجمة مربوطة بلغة تُمرَّر كمعامل، لمن لا يملك سياق `useI18n`.
 *
 * Printed documents, email builders and badge components receive `locale` as
 * an argument rather than reading the provider. Binding it here keeps their
 * call sites in the literal-key `t(...)` form that `dictionary.test.ts` resolves
 * against the catalog — a two-argument `translate(locale, …)` call would slip
 * past that guard.
 * Anything other than "ar" maps to English, exactly as the inline
 * `locale === "ar" ? … : …` ternaries these replace did.
 */
export function translatorFor(locale: string): (key: string) => string {
  const resolved: Locale = locale === "ar" ? "ar" : "en";
  return (key: string) => t(resolved, key);
}
