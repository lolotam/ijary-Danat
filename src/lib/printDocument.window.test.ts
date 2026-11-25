// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLoadedDocument } from "./printDocument";

/**
 * نافذة وهمية تكفي لمسار «احجز ثم حمّل ثم املأ»: تُطلق حدث التحميل فورًا.
 */
function fakeWindow() {
  return {
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    print: vi.fn(),
    location: { replace: vi.fn() },
    document: { readyState: "complete", images: [] },
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "load") listener();
    }),
  };
}

/**
 * The invoice paper is fetched on click. Browsers grant `window.open` only
 * inside the live gesture and Safari spends it on the first await, so the
 * window must be claimed before the loader runs and released if it fails.
 */
describe("openLoadedDocument — the window is claimed before the document is loaded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubBrowser(win: ReturnType<typeof fakeWindow> | null) {
    const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:test/paper"),
      revokeObjectURL: vi.fn(),
    });
    if (typeof requestAnimationFrame === "undefined") {
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    }
    return open;
  }

  it("opens the window first, then navigates it to the loaded paper", async () => {
    const win = fakeWindow();
    const open = stubBrowser(win);
    const order: string[] = [];
    const load = vi.fn(async () => {
      order.push("load:opened=" + open.mock.calls.length);
      return { html: "<p>paper</p>", title: "Invoice", dir: "rtl" as const };
    });

    const outcome = await openLoadedDocument(load, { autoPrint: false });

    expect(outcome).toBe("opened");
    expect(order).toEqual(["load:opened=1"]);
    expect(open).toHaveBeenCalledWith("", "_blank", expect.any(String));
    expect(win.location.replace).toHaveBeenCalledWith("blob:test/paper");
    expect(win.close).not.toHaveBeenCalled();
  });

  it("prints into the claimed window when asked to", async () => {
    const win = fakeWindow();
    stubBrowser(win);

    await openLoadedDocument(async () => ({ html: "<p>paper</p>" }), { autoPrint: true });

    expect(win.print).toHaveBeenCalledTimes(1);
  });

  it("reports blocked without loading when the popup is refused", async () => {
    stubBrowser(null);
    const load = vi.fn(async () => ({ html: "<p>paper</p>" }));

    expect(await openLoadedDocument(load, { autoPrint: false })).toBe("blocked");
    expect(load).not.toHaveBeenCalled();
  });

  it("closes the claimed window and rethrows when loading fails", async () => {
    const win = fakeWindow();
    stubBrowser(win);

    await expect(
      openLoadedDocument(
        async () => {
          throw new Error("rpc down");
        },
        { autoPrint: false },
      ),
    ).rejects.toThrow("rpc down");
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("closes the claimed window when there is nothing to show", async () => {
    const win = fakeWindow();
    stubBrowser(win);

    expect(await openLoadedDocument(async () => null, { autoPrint: false })).toBe("empty");
    expect(win.close).toHaveBeenCalledTimes(1);
  });
});
