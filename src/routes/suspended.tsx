import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { useI18n } from "@/i18n/provider";

export const Route = createFileRoute("/suspended")({
  head: () => ({ meta: [{ title: "IJARY — Suspended" }] }),
  component: SuspendedPage,
});

/**
 * صفحة الشركة المعلّقة: تقول إن الحساب موقوف، وتدعو إلى التواصل مع مالك المنصة.
 *
 * Bilingual through the shared dictionary, Arabic by default and RTL with it.
 * The page reads nothing: no company, no invoice, no session. The account's
 * own address already says which company it is, and a page about a paused
 * account has no reason to reveal anything beyond the message.
 */
function SuspendedPage() {
  const { t, dir } = useI18n();

  // The root head carries the legacy single-company title on every page, so it
  // is replaced here: a paused account must never show another name.
  useEffect(() => {
    document.title = t("suspended.title");
  }, [t]);

  return (
    <main
      id="main-content"
      dir={dir}
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("suspended.heading")}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{t("suspended.body")}</p>
        <p className="mt-6 text-sm font-medium text-foreground">{t("suspended.contact")}</p>
      </div>
    </main>
  );
}
