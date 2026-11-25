/**
 * مفتاح تخزين لحظة آخر إعادة تحميل بسبب مقطع مفقود، داخل الجلسة فقط.
 *
 * `sessionStorage`, not `localStorage`: the marker exists to break a reload loop
 * inside one tab. A value that outlived the tab would suppress a legitimate
 * recovery on the tenant's next visit.
 */
const RELOAD_MARKER_KEY = "danat.staleChunkReloadedAt";

/**
 * أقصر مهلة مسموح بها بين إعادتي تحميل.
 *
 * A chunk that 404s because a deploy replaced the assets directory is cured by
 * exactly one reload. A chunk that 404s for any other reason is not, and without
 * this window the tab would reload forever. A minute is far longer than a reload
 * takes and far shorter than the gap between two deploys.
 */
export const RELOAD_COOLDOWN_MS = 60_000;

/**
 * يقرر ما إذا كانت إعادة التحميل مسموحة الآن بالنظر إلى آخر محاولة.
 *
 * A marker in the future means the clock moved backwards, not that we reloaded
 * moments ago. Treating that as "recently reloaded" would strand the tab on a
 * broken page until the clock caught up, so it is allowed through.
 */
export function shouldReloadForStaleChunk(input: {
  lastReloadAt: number | null;
  now: number;
}): boolean {
  const { lastReloadAt, now } = input;
  if (lastReloadAt === null) return true;
  const elapsed = now - lastReloadAt;
  return elapsed < 0 || elapsed >= RELOAD_COOLDOWN_MS;
}

/**
 * ما تحتاجه المعالجة من العالم الخارجي، مُمرَّرًا لتصبح قابلة للاختبار.
 */
export interface StaleChunkReloadDeps {
  now: () => number;
  /** Throws when storage is unavailable — Safari private mode, blocked cookies. */
  readMarker: () => string | null;
  reload: () => void;
  writeMarker: (value: string) => void;
}

/**
 * يعيد تحميل الصفحة مرة واحدة عندما يفشل تحميل مقطع جافاسكربت مؤجَّل.
 *
 * Dokploy replaces the whole `assets/` directory on every deploy, and every
 * chunk carries a content hash in its name. A tab opened before the deploy holds
 * a document that names the *old* hashes, so its first lazy import after the
 * swap — the Apple Pay QR code, the invoice PDF, the ZIP download — fetches a
 * file that no longer exists and throws "Failed to fetch dynamically imported
 * module". Reloading pulls a fresh SSR document naming the new hashes.
 *
 * The marker is written *before* the reload, which is also what stops a burst:
 * one broken document fires this event once per failed import — the Apple Pay
 * dialog produced three — and every event after the first reads a marker it just
 * wrote and falls inside the cooldown.
 */
export function handleStaleChunkError(deps: StaleChunkReloadDeps): void {
  let lastReloadAt: number | null;
  try {
    const raw = deps.readMarker();
    const parsed = raw === null ? null : Number(raw);
    lastReloadAt = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  } catch (error) {
    // Without readable storage the loop cannot be bounded, and an unbounded
    // reload loop is worse than the broken button it would be trying to fix.
    console.error("Cannot read the stale-chunk marker; skipping the reload.", error);
    return;
  }

  if (!shouldReloadForStaleChunk({ lastReloadAt, now: deps.now() })) return;

  try {
    deps.writeMarker(String(deps.now()));
  } catch (error) {
    // Same reasoning as above: a marker that cannot be written cannot stop the
    // next reload from happening immediately.
    console.error("Cannot record the stale-chunk marker; skipping the reload.", error);
    return;
  }

  deps.reload();
}

/** يمنع تركيب المستمع مرتين لو استُدعي `getRouter` أكثر من مرة على المتصفح. */
let installed = false;

/**
 * يربط المعالجة بحدث Vite الذي يُطلق عند فشل تحميل مقطع مؤجَّل.
 *
 * The listener deliberately does not call `preventDefault()`. Vite rethrows the
 * error only when the event is left uncancelled, and that rethrow is what lets
 * the surrounding `Suspense` boundary keep showing its fallback while the reload
 * is in flight. Cancelling it instead resolves `React.lazy` with `undefined` and
 * React then throws a far less legible "element type is invalid".
 */
export function installStaleChunkReload(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;

  window.addEventListener("vite:preloadError", () => {
    handleStaleChunkError({
      now: () => Date.now(),
      readMarker: () => window.sessionStorage.getItem(RELOAD_MARKER_KEY),
      reload: () => window.location.reload(),
      writeMarker: (value) => window.sessionStorage.setItem(RELOAD_MARKER_KEY, value),
    });
  });
}
