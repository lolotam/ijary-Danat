import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { translatorFor } from "@/i18n/dictionary";
import { useOptionalI18n } from "@/i18n/provider";

export const Route = createFileRoute("/not-found")({
  head: () => ({ meta: [{ title: "404 — IJARY" }] }),
  component: NotFoundPage,
});

/**
 * صفحة 404: لا تفصح عن أي شركة ولا تعرض هوية المضيف، عربي RTL مع إنجليزي.
 *
 * Serves both as the route component for `/not-found` and as the router's
 * `notFoundComponent` for any unmatched path. As `notFoundComponent` it renders
 * outside `RootComponent`, where the i18n provider is not mounted (TanStack
 * replaces the matched content instead of nesting it) — so it falls back to a
 * bilingual line built from the same dictionary keys, exactly like the root
 * error boundary next to it.
 */
export function NotFoundPage() {
  const i18n = useOptionalI18n();
  // The root head carries the legacy single-company meta on every page; the
  // title is corrected here so a 404 never names a company.
  useEffect(() => {
    document.title = "404 — IJARY";
  });
  const t =
    i18n?.t ?? ((key: string) => `${translatorFor("ar")(key)} / ${translatorFor("en")(key)}`);

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">{t("notFound.heading")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("notFound.body")}</p>
        <div className="mt-6">
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("auth.backHome")}
          </a>
        </div>
      </div>
    </main>
  );
}
