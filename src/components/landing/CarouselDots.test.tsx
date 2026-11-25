/**
 * @vitest-environment jsdom
 *
 * The render-count assertion is the whole point: the slide index used to live
 * in the page component, so every 5-second autoplay tick re-rendered the whole
 * landing page to recolour these dots.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CarouselDots } from "./CarouselDots";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/**
 * بديل مبسّط لواجهة الكاروسيل يسمح بإطلاق حدث الاختيار يدويًا في الاختبار.
 *
 * A local stub rather than a module mock: mocking embla itself would test the
 * mock, and the component only ever touches these four methods.
 */
function makeApi(startIndex = 0) {
  let index = startIndex;
  // Keyed by event name, not a flat set: the component must subscribe to both
  // `select` and `reInit`, and a flat set cannot tell those subscriptions apart.
  const handlers = new Map<string, Set<() => void>>();

  return {
    on: (event: string, handler: () => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: () => void) => {
      handlers.get(event)?.delete(handler);
    },
    scrollTo: (next: number) => {
      index = next;
    },
    selectedScrollSnap: () => index,
    /** يُرجع أسماء الأحداث المشترَك بها حاليًا، للتحقق من إلغاء الاشتراك. */
    subscribedEvents: () =>
      [...handlers.entries()]
        .filter(([, set]) => set.size > 0)
        .map(([event]) => event)
        .sort(),
    /** ينقل الكاروسيل إلى شريحة ويُطلق حدثًا، كما يفعل التشغيل التلقائي. */
    emit: (event: string, next: number) => {
      index = next;
      handlers.get(event)?.forEach((handler) => handler());
    },
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** يعيد فهرس الزر الذي يحمل aria-current، أو -1 إن لم يوجد. */
function currentDot(): number {
  const buttons = Array.from(container.querySelectorAll("button"));
  return buttons.findIndex((button) => button.getAttribute("aria-current") === "true");
}

describe("CarouselDots", () => {
  test("advancing the carousel does not re-render the parent", () => {
    const api = makeApi();
    let parentRenders = 0;

    /** أب يَعُدّ مرات إعادة الرسم للتحقق من عزل فهرس الشريحة داخل الابن. */
    function CountingParent() {
      parentRenders += 1;
      return <CarouselDots api={api as never} count={3} locale="en" />;
    }

    act(() => root.render(<CountingParent />));
    expect(parentRenders).toBe(1);
    expect(currentDot()).toBe(0);

    act(() => api.emit("select", 2));
    expect(currentDot()).toBe(2);

    act(() => api.emit("select", 1));
    expect(currentDot()).toBe(1);

    expect(parentRenders).toBe(1);
  });

  test("resyncs on reInit, which the shared carousel also treats as selection-relevant", () => {
    // src/components/ui/carousel.tsx subscribes onSelect to BOTH `select` and
    // `reInit`. Embla re-initialises when the slide set changes, and it does
    // not always emit `select` afterwards — listening only to `select` can
    // leave every dot inactive after the slides query refetches.
    const api = makeApi();
    act(() => root.render(<CarouselDots api={api as never} count={3} locale="en" />));

    act(() => api.emit("reInit", 1));

    expect(currentDot()).toBe(1);
  });

  test("renders without an api, which is the state on first paint", () => {
    act(() => root.render(<CarouselDots api={null} count={4} locale="en" />));

    expect(container.querySelectorAll("button")).toHaveLength(4);
    expect(currentDot()).toBe(0);
  });

  test("seeds the active dot from an api that is already past the first slide", () => {
    const api = makeApi(2);
    act(() => root.render(<CarouselDots api={api as never} count={3} locale="en" />));

    expect(currentDot()).toBe(2);
  });

  test("clicking a dot scrolls the carousel to it", () => {
    const api = makeApi();
    const scrollTo = vi.spyOn(api, "scrollTo");
    act(() => root.render(<CarouselDots api={api as never} count={3} locale="en" />));

    act(() => {
      container.querySelectorAll("button")[2].click();
    });

    expect(scrollTo).toHaveBeenCalledWith(2);
  });

  test("labels each dot in the active locale", () => {
    act(() => root.render(<CarouselDots api={null} count={2} locale="ar" />));
    expect(container.querySelectorAll("button")[0].getAttribute("aria-label")).toBe("الشريحة 1");

    act(() => root.render(<CarouselDots api={null} count={2} locale="en" />));
    expect(container.querySelectorAll("button")[0].getAttribute("aria-label")).toBe("Slide 1");
  });

  test("unsubscribes from the api on unmount", () => {
    // This test owns its container and root: unmounting the shared ones would
    // collide with the afterEach hook, and patching around that couples the
    // test to the hook's internals.
    const localContainer = document.createElement("div");
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);

    const api = makeApi();
    act(() => localRoot.render(<CarouselDots api={api as never} count={2} locale="en" />));

    // Assert against the stub's own bookkeeping rather than an `off` spy: a
    // spy only proves `off` was called, not that it was called with the right
    // event and the same handler that was subscribed. Leaving one live
    // subscription behind is exactly the leak this guards against.
    expect(api.subscribedEvents()).toEqual(["reInit", "select"]);

    act(() => localRoot.unmount());

    expect(api.subscribedEvents()).toEqual([]);
    localContainer.remove();
  });
});
