# --- Dependencies ---
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
# No `|| bun install` fallback. `--frozen-lockfile` exists to fail the build
# when package.json and bun.lock disagree; falling back to a fresh resolution
# turned that deliberate failure into a silent one, so an image could ship
# dependency versions nothing had ever tested. A frozen install that fails IS
# the signal — commit the updated lockfile.
RUN bun install --frozen-lockfile

# --- Build ---
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public build-time env (non-secret, but environment-specific) — MUST be supplied
# at build time by Dokploy/CI. No defaults on purpose: a baked-in default pins the
# production endpoint and anon key into every image built without overrides, and
# makes the key impossible to rotate by configuration alone.
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_PUBLISHABLE_KEY=
# Optional: an empty DSN leaves Sentry disabled (see src/instrument.client.ts).
ARG VITE_SENTRY_DSN=
# Optional: either value empty leaves PostHog disabled (see src/routes/__root.tsx).
ARG VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=
ARG VITE_PUBLIC_POSTHOG_HOST=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_PUBLIC_POSTHOG_PROJECT_TOKEN=$VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
ENV VITE_PUBLIC_POSTHOG_HOST=$VITE_PUBLIC_POSTHOG_HOST
ENV NITRO_PRESET=bun
# SENTRY_AUTH_TOKEN (optional) lets the Sentry Vite plugin upload source maps.
# It arrives as a BuildKit secret, never an ARG or ENV: those are recorded in
# the build stage's image config and history on the build host, where anyone
# with Docker access can read them. A secret mount exists only for this one
# RUN. With no secret supplied the variable is empty and the upload is skipped,
# so the build still succeeds.
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)" \
    bun run build

# --- Runtime ---
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Chromium + Arabic/Latin fonts live only in the runtime stage. The build stage
# never renders PDFs; installing here (and only here) keeps deps/build layers lean.
# fonts-noto-core: Noto Naskh Arabic — without glyphs Chromium shapes correctly
#   then draws tofu boxes (looks like a Chromium bug; it is a missing-font bug).
# fonts-dejavu-core: Latin/digits so mixed AR/EN reports render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-core \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Debian chromium package installs the binary at /usr/bin/chromium.
ENV CHROMIUM_PATH=/usr/bin/chromium
COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["bun", "run", ".output/server/index.mjs"]
