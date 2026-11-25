/**
 * @vitest-environment jsdom
 *
 * The render-count assertion is the whole point. A test that only checked
 * "the typed text eventually appears" would also pass with the animation
 * state hoisted back into the page component, which is the defect this
 * component exists to prevent.
 *
 * It is a gate, not a measurement. Advancing every timer inside one `act()`
 * lets React batch the updates, so hoisting the state here produces 2 renders
 * rather than one-per-character — enough to fail `toBe(1)`, which is all this
 * needs to do. The ~65 renders that motivated the change happen because real
 * `setInterval` ticks arrive in separate macrotasks, which React does not
 * batch across. Do not "fix" this test by asserting a larger number.
 *
 * Same jsdom + createRoot technique as AuthProvider.test.tsx — this repo has
 * no @testing-library and does not need one here.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TypedText } from "./TypedText";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** يضبط استعلام تفضيل تقليل الحركة لتُرجع القيمة المطلوبة. */
function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  // Restricted on purpose: a bare vi.useFakeTimers() deadlocks the vitest
  // worker under jsdom. See the Global Constraints section of the plan.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  setReducedMotion(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TypedText", () => {
  test("animating does not re-render the parent", () => {
    let parentRenders = 0;

    /** أب يَعُدّ مرات إعادة الرسم للتحقق من عزل حالة الكتابة داخل الابن. */
    function CountingParent() {
      parentRenders += 1;
      return <TypedText text="Danat Al Jahra" speedMs={10} />;
    }

    act(() => root.render(<CountingParent />));
    expect(parentRenders).toBe(1);

    const animated = () => container.querySelector('[aria-hidden="true"]')?.textContent ?? "";
    expect(animated()).toBe("");

    act(() => {
      vi.advanceTimersByTime(10 * "Danat Al Jahra".length + 50);
    });

    expect(animated()).toBe("Danat Al Jahra");
    expect(parentRenders).toBe(1);
  });

  test("the full string is readable before any character is typed", () => {
    act(() => root.render(<TypedText text="دانة الجهراء" speedMs={10} />));

    const srOnly = container.querySelector(".sr-only");
    expect(srOnly?.textContent).toBe("دانة الجهراء");
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe("");
  });

  test("reduced motion shows the whole string immediately", () => {
    setReducedMotion(true);
    act(() => root.render(<TypedText text="Danat Al Jahra" speedMs={10} />));

    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe("Danat Al Jahra");
  });

  test("the cursor renders only when asked for and is hidden from assistive tech", () => {
    act(() => root.render(<TypedText text="x" withCursor />));
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden).toHaveLength(2);
    expect(hidden[1].textContent).toBe("|");

    act(() => root.render(<TypedText text="x" />));
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
