// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";

// Source-map upload only when a token is present: without one the plugin
// would still emit maps and warn on every build, and a self-hosted build
// must never serve maps it did not upload.
const sentryPlugins = process.env.SENTRY_AUTH_TOKEN
  ? [
      sentryTanstackStart({
        org: "lolotam",
        project: "danat-future",
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
      }),
    ]
  : [];

export default defineConfig({
  plugins: sentryPlugins,
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
