import * as Sentry from "@sentry/tanstackstart-react";

/**
 * يهيّئ Sentry في المتصفح — يُستدعى أول شيء في `src/client.tsx` قبل الترطيب.
 *
 * Exported and *called* rather than imported for side effects: Vite's bundler
 * dropped a side-effect-only `import "./instrument.client"` from the entry
 * (verified by probe in the built assets), and a bare import that silently
 * vanishes is exactly the failure that makes monitoring look configured while
 * it captures nothing. A call cannot be tree-shaken.
 *
 * The DSN is a build arg (`VITE_SENTRY_DSN`, see deploy/README.md); an empty
 * value keeps dev and preview builds silent instead of erroring on a
 * placeholder. A DSN is a public write-only key, so shipping it in the bundle
 * is by design. Router-aware tracing is attached in `src/router.tsx` because
 * it needs the router instance, which does not exist yet here.
 *
 * Sample rates mirror the Sentry guide: every transaction while traffic is
 * small, one in ten sessions replayed, every errored session replayed.
 */
export function initSentryClient(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [Sentry.replayIntegration()],
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
