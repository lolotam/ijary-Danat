/**
 * @vitest-environment jsdom
 *
 * WhatsApp profile-picture URLs die on their own — they carry a hard expiry —
 * so both ways an avatar can fail have to end at the initials, never at a
 * broken-image icon: the link whose stamped expiry has passed (skipped without
 * a request) and the one that fails for any other reason (onError).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ChatAvatar } from "./WhatsAppChatList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Shapes copied from production URLs; `oe` is the expiry in hex seconds. */
const FAR_FUTURE = `https://pps.whatsapp.net/v/t61/pic.jpg?ccb=11-4&oe=${(0x7fffffff).toString(16)}`;
const LONG_EXPIRED = "https://pps.whatsapp.net/v/t61/pic.jpg?ccb=11-4&oe=5AA89C26";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * يركّب الصورة الرمزية بالرابط المطلوب داخل جذر React واحد.
 *
 * Re-rendering into the same root is what the "refreshed URL" case needs: a
 * fresh root would reset the failure state by construction and prove nothing.
 */
function render(avatarUrl: string | null) {
  act(() => {
    root.render(<ChatAvatar avatarUrl={avatarUrl} initials="مح" />);
  });
}

describe("ChatAvatar", () => {
  test("renders the picture while its stamped expiry is in the future", () => {
    render(FAR_FUTURE);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(FAR_FUTURE);
  });

  test("falls back to initials when the picture fails to load", () => {
    render(FAR_FUTURE);
    const image = container.querySelector("img");
    act(() => {
      image?.dispatchEvent(new Event("error", { bubbles: true }));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("مح");
  });

  test("never requests a link whose expiry has already passed", () => {
    // The CDN answers an expired link with 403, so requesting it buys a failed
    // round trip and a flash of broken image before the same initials.
    render(LONG_EXPIRED);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("مح");
  });

  test("shows initials when there is no picture at all", () => {
    render(null);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("مح");
  });

  test("a refreshed URL clears an earlier failure", () => {
    // "Sync profile pictures" replaces a dead link while the inbox is open;
    // the avatar has to try again rather than stay on initials until reload.
    render(FAR_FUTURE);
    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("error", { bubbles: true }));
    });
    expect(container.querySelector("img")).toBeNull();

    render(`${FAR_FUTURE}&v=2`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`${FAR_FUTURE}&v=2`);
  });
});
