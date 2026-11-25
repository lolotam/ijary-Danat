import * as Sentry from "@sentry/tanstackstart-react";
import { QueryClient } from "@tanstack/react-query";
import { createRouter, parseSearchWith, stringifySearchWith } from "@tanstack/react-router";

import { shouldRetryQuery } from "./lib/queryRetry";
import { installStaleChunkReload } from "./lib/staleChunkReload";
import { routeTree } from "./routeTree.gen";

/**
 * Default TanStack search parsing uses JSON.parse on every value. That turns
 * MyFatoorah PaymentIds (18–20 digit integers) into IEEE-754 numbers and
 * silently corrupts them (e.g. 100620210000016004 → 100620210000016000), so
 * GetPaymentStatus returns "No data match" and the portal shows a verify error.
 * Keep long pure-digit strings as strings.
 */
function parseSearchValue(value: string) {
  if (/^-?\d{16,}$/.test(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * ينشئ موجّه التطبيق وعميل الاستعلامات المشترك بينهما.
 *
 * TanStack Start calls this on both the server and the client, so anything
 * constructed here exists twice per request in SSR — which is why the router,
 * not a module-level singleton, owns the `QueryClient`: a shared one would leak
 * one visitor's cached rows into the next visitor's render.
 */
export const getRouter = () => {
  // The client entry calls this at boot, which is the one hook TanStack Start
  // gives us on both sides; the installer no-ops on the server and on repeat
  // calls. Registering here rather than in a route component means a tab that
  // survived a deploy recovers on its first lazy import anywhere in the app —
  // the Apple Pay QR, the invoice PDF, the ZIP download — not just on the route
  // that happened to mount the listener.
  installStaleChunkReload();

  /**
   * إعدادات افتراضية مشتركة لكل استعلامات React Query.
   *
   * A bare `new QueryClient()` means `staleTime: 0` and `refetchOnWindowFocus:
   * true`, so every remount and every alt-tab re-ran the query — and each of
   * those round-trips re-evaluates the RLS policies, which is where the cost
   * actually is (a units listing measured 1.2 ms as superuser against 9.5 ms as
   * `authenticated`, most of it planning). Production shows 4.3 million
   * sequential scans of the six-row `user_roles` table, which is that churn.
   *
   * Thirty seconds is short enough that an admin never reasons from visibly
   * stale money, and mutations still call `invalidateQueries`, which ignores
   * `staleTime` entirely. Hooks that need different behaviour override it
   * locally — `useBackups` pins `staleTime: 0`, the mailbox re-enables
   * `refetchOnWindowFocus` — and those overrides still win.
   *
   * `retry` replaces React Query's blanket three attempts. The default treats a
   * refusal the same as a dropped socket, so one visit to the Roles screen —
   * whose tables do not exist in production — fired thirteen requests asking a
   * question the server had already answered. See `lib/queryRetry.ts`.
   */
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    parseSearch: parseSearchWith(parseSearchValue),
    stringifySearch: stringifySearchWith(JSON.stringify, parseSearchValue),
  });

  // Route-aware page-load/navigation spans need the router instance, so the
  // integration is added here rather than in instrument.client.ts. Client only:
  // the SSR pass has no browser to trace.
  if (!router.isServer) {
    Sentry.addIntegration(Sentry.tanstackRouterBrowserTracingIntegration(router));
  }

  return router;
};
