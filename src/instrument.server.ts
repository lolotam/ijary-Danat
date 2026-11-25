import * as Sentry from "@sentry/tanstackstart-react";

/**
 * يهيّئ Sentry على الخادم — يُستدعى في أعلى `src/server.ts` قبل أي طلب.
 *
 * Called from the server entry rather than loaded with `node --import`: the
 * container runs the Nitro output under Bun (`CMD ["bun", "run", ...]`), which
 * ignores `NODE_OPTIONS=--import`. Sentry documents this import-based path for
 * hosts where CLI flags cannot be set; it instruments native `fetch`/`http`
 * only, which is all this app's server side uses. It is a call, not a bare
 * side-effect import, for the reason given in `instrument.client.ts`.
 *
 * `SENTRY_DSN` is read at runtime, not build time, so it can be rotated in
 * Dokploy without a rebuild; it falls back to the build-time `VITE_SENTRY_DSN`
 * so a single value works for both sides.
 */
export function initSentryServer(): void {
  const dsn = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 1.0,
  });
}
