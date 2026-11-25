import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ThemeProvider } from "../components/ThemeProvider";
import { AuthProvider } from "../auth/AuthProvider";
import { I18nProvider } from "../i18n/provider";
import { getPublicSupabaseConfig } from "../fns/publicRuntimeConfig";
import type { PublicSupabaseConfig } from "../fns/publicRuntimeConfig";
import { getPublicBranding } from "../fns/publicBranding";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import * as Sentry from "@sentry/tanstackstart-react";
import { SkipLink } from "../components/SkipLink";
import { PostHogProvider, usePostHog } from "posthog-js/react";
import { redactEventUrls, redactReplayRequestUrl } from "../lib/posthogPrivacy";
import { maskReplayAttribute } from "../lib/posthogReplayAttributes";

function supabaseConfigScript(config: PublicSupabaseConfig): string {
  // <-escape so env values can never break out of the inline <script>.
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return `window.__SUPABASE_CONFIG=${serialized};`;
}

function NotFoundComponent() {
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">
          الصفحة غير موجودة / Page not found
        </h2>
        <div className="mt-6">
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            الرئيسية / Home
          </a>
        </div>
      </div>
    </main>
  );
}

/**
 * حدّ الخطأ الجذري: يعرض رسالة واحدة ويبلّغ عنها لـ Sentry وLovable.
 *
 * `error` is `unknown`, not `Error`: TanStack Router widened `ErrorComponentProps`
 * because JavaScript can throw any value, and a route that rejects with a string
 * or a plain object used to reach `Sentry.captureException` as a non-Error and
 * arrive in Sentry with no stack. Normalising here keeps one shape downstream.
 */
function ErrorComponent({ error, reset }: ErrorComponentProps) {
  // Memoised on the original value: normalising inline built a NEW Error on
  // every render, and since the reporting effect depends on it, any rerender
  // while this fallback stays mounted reported the same failure to Sentry and
  // Lovable again (Codex review, PR #219).
  const thrown = useMemo(
    () => (error instanceof Error ? error : new Error(String(error))),
    [error],
  );
  console.error(error);
  const router = useRouter();
  const posthog = usePostHog();
  useEffect(() => {
    reportLovableError(thrown, { boundary: "tanstack_root_error_component" });
    // The boundary swallows the throw, so global exception handlers never see it.
    Sentry.captureException(thrown);
    posthog.captureException(thrown);
  }, [posthog, thrown]);

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-background px-4"
    >
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          حدث خطأ / Something went wrong
        </h1>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            حاول مجددًا / Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            الرئيسية / Home
          </a>
        </div>
      </div>
    </main>
  );
}

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  loader: async () => ({
    supabaseConfig: await getPublicSupabaseConfig(),
    branding: await getPublicBranding(),
  }),
  head: ({ loaderData }) => ({
    scripts:
      loaderData?.supabaseConfig.url && loaderData.supabaseConfig.publishableKey
        ? [{ children: supabaseConfigScript(loaderData.supabaseConfig) }]
        : [],
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover lets standalone (installed) mode draw under the
      // notch; sticky headers pad with env(safe-area-inset-*) to compensate.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#0b2523" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Danat" },
      { title: "Danat Future (Danat-future) — Real Estate & Property Management Platform" },
      {
        name: "description",
        content:
          "منصة متكاملة لإدارة العقارات، العقود، الفواتير، والتحصيل. Integrated real-estate operations platform for property, lease, invoicing, and collections.",
      },
      { name: "author", content: "Danat Al Mustaqbal Real Estate" },
      // Meta Business domain verification. A public claim token, not a secret,
      // which is why it lives in source. It sits in the shared head config so
      // it is served on the site root — the URL Meta actually fetches.
      {
        name: "facebook-domain-verification",
        content: "up2j0uygy7kwwnr5xhusrvk4qwslyv",
      },
      {
        property: "og:title",
        content: "دانة المستقبل العقارية | Danat Al Mustaqbal Real Estate",
      },
      {
        property: "og:description",
        content:
          "منصة متكاملة لإدارة العقارات، العقود، الفواتير، والتحصيل. Integrated real-estate operations platform for property, lease, invoicing, and collections.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "دانة المستقبل العقارية | Danat Al Mustaqbal Real Estate" },
      {
        name: "twitter:description",
        content:
          "منصة متكاملة لإدارة العقارات، العقود، الفواتير، والتحصيل. Integrated real-estate operations platform for property, lease, invoicing, and collections.",
      },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/gE8nBnZ3uthTT4sDKwDyIDiigom2/social-images/social-1784153377096-From_Klickpin.com-_988680924538704344-pin-id-988680924538704344-story-1.webp",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/gE8nBnZ3uthTT4sDKwDyIDiigom2/social-images/social-1784153377096-From_Klickpin.com-_988680924538704344-pin-id-988680924538704344-story-1.webp",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: loaderData?.branding?.faviconUrl || "/favicon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Tajawal:wght@400;500;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <HeadContent />
      </head>
      <body>
        <PostHogRoot>
          <SkipLink />
          {children}
        </PostHogRoot>
        <Scripts />
      </body>
    </html>
  );
}

/**
 * يغلّف التطبيق بمزوّد PostHog في المتصفح، ويتركه بلا تحليلات إن غاب المفتاح أو المضيف.
 *
 * Missing configuration disables PostHog rather than throwing — same contract
 * as an empty `VITE_SENTRY_DSN` — so a build without the two build args still
 * serves every page. The screens are full of tenant names, civil IDs and
 * amounts, and PostHog is a third party: autocapture is off (it ships clicked
 * elements' text), every event's URLs are stripped of query, hash and ID
 * segments by `redactEventUrls`, and replay masks all text, inputs and
 * identifying attributes here in code so a dashboard toggle can never unmask
 * it. Product events are explicit
 * `capture()` calls carrying no personal data.
 */
function PostHogRoot({ children }: { children: ReactNode }) {
  // The browser SDK must never initialize during SSR.
  if (typeof window === "undefined") return children;

  const apiKey = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined;
  const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined;
  if (!apiKey || !host) return children;

  return (
    <PostHogProvider
      apiKey={apiKey}
      options={{
        api_host: host,
        defaults: "2025-05-24",
        person_profiles: "identified_only",
        autocapture: false,
        capture_exceptions: true,
        before_send: redactEventUrls,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "*",
          maskCapturedNetworkRequestFn: redactReplayRequestUrl,
          maskAttributeFn: maskReplayAttribute,
        },
        debug: import.meta.env.DEV,
      }}
    >
      {children}
    </PostHogProvider>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <AuthProvider>
            <Outlet />
          </AuthProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
