import { describe, expect, it, vi } from "vitest";

import {
  handleStaleChunkError,
  RELOAD_COOLDOWN_MS,
  shouldReloadForStaleChunk,
  type StaleChunkReloadDeps,
} from "./staleChunkReload";

const NOW = 1_700_000_000_000;

/**
 * يبني اعتماديات المعالجة مع تخزين حقيقي في الذاكرة، لا وهمي.
 *
 * The marker is a real read-then-write round trip rather than a mock, because
 * the behaviour under test *is* that round trip: a write that never lands is the
 * failure mode this whole module exists to prevent.
 */
function deps(overrides: Partial<StaleChunkReloadDeps> & { marker?: string | null } = {}) {
  const store = { value: overrides.marker ?? null };
  const reload = vi.fn();
  const base: StaleChunkReloadDeps = {
    now: () => NOW,
    readMarker: () => store.value,
    reload,
    writeMarker: (value) => {
      store.value = value;
    },
  };
  const { marker: _marker, ...rest } = overrides;
  return { deps: { ...base, ...rest }, reload, store };
}

describe("shouldReloadForStaleChunk", () => {
  it.each([
    ["reloads when nothing has been recorded yet", null, true],
    // The loop guard: a chunk missing for a reason a reload cannot fix would
    // otherwise reload the tab forever.
    [
      "refuses while the recorded reload is inside the cooldown",
      NOW - RELOAD_COOLDOWN_MS + 1,
      false,
    ],
    ["reloads once the cooldown has elapsed to the millisecond", NOW - RELOAD_COOLDOWN_MS, true],
    // A backwards clock jump must not strand the tab on a broken page.
    ["reloads when the clock jumped back and the marker sits in the future", NOW + 5_000, true],
  ] as const)("%s", (_scenario, lastReloadAt, expected) => {
    expect(shouldReloadForStaleChunk({ lastReloadAt, now: NOW })).toBe(expected);
  });
});

describe("handleStaleChunkError", () => {
  it("reloads and records the attempt on a first failure", () => {
    const { deps: d, reload, store } = deps();

    handleStaleChunkError(d);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.value).toBe(String(NOW));
  });

  it("reloads only once when one broken document fires the event repeatedly", () => {
    // The reported Apple Pay failure logged three of these from a single page
    // load. Three reloads would be three round trips and two wasted documents.
    const { deps: d, reload } = deps();

    handleStaleChunkError(d);
    handleStaleChunkError(d);
    handleStaleChunkError(d);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload again while the recorded attempt is still fresh", () => {
    const { deps: d, reload } = deps({ marker: String(NOW - 1_000) });

    handleStaleChunkError(d);

    expect(reload).not.toHaveBeenCalled();
  });

  it("treats an unparsable marker as no marker at all", () => {
    // Any other value under that key is not ours; refusing to reload because of
    // it would leave the tenant on a page whose buttons do nothing.
    const { deps: d, reload } = deps({ marker: "not-a-timestamp" });

    handleStaleChunkError(d);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("skips the reload when the marker cannot be read", () => {
    // Safari private mode throws on sessionStorage. Without a readable marker
    // the loop is unbounded, so not reloading is the safer failure.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps: d, reload } = deps({
      readMarker: () => {
        throw new Error("SecurityError: sessionStorage is unavailable");
      },
    });

    handleStaleChunkError(d);

    expect(reload).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("skips the reload when the marker cannot be written", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const {
      deps: d,
      reload,
      store,
    } = deps({
      writeMarker: () => {
        throw new Error("QuotaExceededError");
      },
    });

    handleStaleChunkError(d);

    expect(reload).not.toHaveBeenCalled();
    expect(store.value).toBeNull();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
