/**
 * خيارات مشتركة لاستعلامات البيانات المالية.
 *
 * The shared `QueryClient` (`src/router.tsx`) turns `refetchOnWindowFocus` off:
 * every refetch re-evaluates the RLS policies, and that is where a request's
 * cost sits — the same units listing measures 1.2 ms as superuser against 9.5 ms
 * as `authenticated`, most of it planning.
 *
 * Money is the exception, and it is an exception about correctness rather than
 * freshness. Payments arrive server-side without the admin doing anything — the
 * MyFatoorah webhook and the reconcile cron both settle invoices — so for these
 * views, coming back to the tab is the moment new data is most likely to exist
 * and the moment a stale number is most likely to be acted on.
 *
 * `staleTime` still gates how often this can fire: a hook that sets five minutes
 * refetches on focus at most once per five minutes, not on every alt-tab.
 */
export const FINANCE_QUERY_OPTIONS = {
  refetchOnWindowFocus: true,
} as const;
