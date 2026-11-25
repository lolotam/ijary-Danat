/**
 * @vitest-environment jsdom
 *
 * Same jsdom + createRoot technique as TypedText.test.tsx — this repo has no
 * @testing-library.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebounce } from "./useDebounce";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: string;

/** مكوّن اختبار يعرض القيمة المؤجَّلة ليقرأها الاختبار. */
function Probe({ value }: { value: string }) {
  seen = useDebounce(value);
  return null;
}

/** يعيد رسم المكوّن بقيمة إدخال جديدة. */
function renderWith(value: string) {
  act(() => root.render(<Probe value={value} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useDebounce", () => {
  it("returns the first value immediately", () => {
    renderWith("a");
    expect(seen).toBe("a");
  });

  it("holds a new value until it has been stable for 1000 ms", () => {
    renderWith("a");
    renderWith("ab");
    act(() => vi.advanceTimersByTime(999));
    expect(seen).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(seen).toBe("ab");
  });

  it("restarts the wait when the value changes mid-window", () => {
    renderWith("a");
    renderWith("ab");
    act(() => vi.advanceTimersByTime(600));
    renderWith("abc");
    act(() => vi.advanceTimersByTime(600));
    expect(seen).toBe("a");
    act(() => vi.advanceTimersByTime(400));
    expect(seen).toBe("abc");
  });
});
