# Landing Page Render Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `LandingPage` re-rendering its entire ~1950-line tree every time the hero typewriter ticks or the carousel advances, by moving that transient state down into two new leaf components.

**Architecture:** Transient state moves to the leaf that reads it. `TypedText` owns one `useTypewriter` call; `CarouselDots` owns the slide index and the embla `select` subscription. `LandingPage` then holds no rapidly-changing state, so nothing above needs memoizing. A third, unrelated one-line change marks the scroll listener passive.

**Tech Stack:** React 19, TanStack Start, TypeScript, Vitest 4 (jsdom via per-file docblock), Tailwind CSS 4, Bun.

**Spec:** `docs/superpowers/specs/2026-08-16-landing-render-hygiene-design.md`

## Global Constraints

- **Arabic doc comments.** Every function and component gets a `/** … */` comment **above** it whose first line is an Arabic description of what it does. English may follow, for the *why* only. This is an AGENTS.md rule and is non-negotiable. Comments explain *why*, never restate *what* the next line does.
- **No `@testing-library`.** This repo deliberately has none. Tests use a `@vitest-environment jsdom` docblock plus `createRoot` from `react-dom/client` and `act` from `react`. Follow `src/auth/AuthProvider.test.tsx` exactly.
- **`vitest.config.ts` sets `environment: "node"` globally**, so the per-file `@vitest-environment jsdom` docblock is mandatory in any test that touches the DOM.
- **Set `IS_REACT_ACT_ENVIRONMENT`.** Add `(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;` at module scope in every jsdom test, or `act()` logs a warning on every call.
- **Fake timers MUST be restricted.** Under `jsdom`, a bare `vi.useFakeTimers()` **deadlocks the vitest worker** — the run dies after 60 s with `[vitest-pool-runner]: Timeout waiting for worker to respond` and zero tests executed. This was reproduced and then fixed by restricting the fake set. Always write:
  ```ts
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  ```
  Do not "simplify" this back to `vi.useFakeTimers()`. The one existing fake-timer test in the repo (`src/fns/notificationDrainJob.test.ts`) gets away with the bare call only because it runs under `environment: node`, with no jsdom and no React root.
- **jsdom tests are slow to start** — roughly 40 s of environment setup per file. A test file that appears to hang for half a minute is normal; one that hits 60 s and reports `no tests` is the fake-timer deadlock above.
- **Do not modify `src/hooks/useTypewriter.ts`.** Its behaviour is correct; only its call site was wrong.
- **Do not add `React.memo`, `useMemo`, or `useCallback`** as part of this change. Moving state down is the fix.
- **Do not attempt to split `src/routes/index.tsx`** beyond the extractions named here. It stays 2118 lines and that is accepted.
- **Do not add any new dependency.**
- File size ceiling is 500–600 lines for new files; both new files are far under it.
- Gates that must pass before each commit: `bun run lint`, `bun run typecheck`, `bun run test`.
- **Guards are additionally required and are run by the orchestrator, not by the implementer.** AGENTS.md mandates `clean-code-guard` over changed production code and `test-guard` over changed tests before anything is presented, committed or merged. A delegated implementer cannot invoke them, so they run on the delegated diff during review — the implementer's job ends at green gates plus a report. `docs-guard` applies to this spec and plan themselves once the implementation lands, because they make checkable claims about the code — line anchors, prop types, event subscriptions — that drift the moment the code moves.

---

### Task 1: `TypedText` leaf component

**Files:**
- Create: `src/components/landing/TypedText.tsx`
- Test: `src/components/landing/TypedText.test.tsx`

**Interfaces:**
- Consumes: `useTypewriter` from `@/hooks/useTypewriter` — signature `useTypewriter(text: string, speedMs?: number, startDelayMs?: number): string`. Defaults are `speedMs = 55`, `startDelayMs = 0`.
- Produces: `export function TypedText(props: TypedTextProps)` where
  ```ts
  type TypedTextProps = {
    text: string;
    speedMs?: number;
    startDelayMs?: number;
    withCursor?: boolean;
  };
  ```
  Task 3 renders `<TypedText text={heroTitle} speedMs={90} withCursor />` and `<TypedText text={heroSubtitle} speedMs={22} startDelayMs={1500} />`.

**Background the implementer needs.** `useTypewriter` calls `setState` once per character. Today both calls live in `LandingPage`, so each character re-renders ~1950 lines of JSX — about 65 full-tree renders in 2.6 seconds, during hydration. Wrapping the animation in its own component confines those renders to a few spans.

The markup being replaced pairs an `sr-only` span holding the **complete** string with an `aria-hidden` span holding the **animating** string. That pairing is load-bearing: the animated copy starts empty, so without the `sr-only` sibling a crawler or screen reader sees an empty `<h1>`. Preserve it exactly.

- [ ] **Step 1: Write the failing test**

Create `src/components/landing/TypedText.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 *
 * The render-count assertion is the whole point. A test that only checked
 * "the typed text eventually appears" would also pass with the animation
 * state hoisted back into the page component, which is the defect this
 * component exists to prevent.
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run test -- src/components/landing/TypedText.test.tsx`
Expected: FAIL — `Failed to resolve import "./TypedText"`.

- [ ] **Step 3: Write the component**

Create `src/components/landing/TypedText.tsx`:

```tsx
import { useTypewriter } from "@/hooks/useTypewriter";

type TypedTextProps = {
  /** النص الكامل المطلوب كتابته حرفًا بحرف. */
  text: string;
  /** المدة بين كل حرفين بالمللي ثانية. */
  speedMs?: number;
  /** تأخير البدء بالمللي ثانية. */
  startDelayMs?: number;
  /** إظهار مؤشر الكتابة الوامض بعد النص. */
  withCursor?: boolean;
};

/**
 * يكتب نصًا حرفًا بحرف مع إبقاء النص الكامل متاحًا لقارئات الشاشة ومحرّكات البحث.
 *
 * The animation state lives here rather than in the page component on purpose:
 * `useTypewriter` sets state once per character, and holding it any higher
 * re-rendered the entire landing page ~65 times during hydration. The
 * `sr-only` sibling is not decoration — the animated span starts empty, so it
 * is the only copy of the heading a crawler or screen reader ever sees.
 */
export function TypedText({ text, speedMs, startDelayMs, withCursor = false }: TypedTextProps) {
  const typed = useTypewriter(text, speedMs, startDelayMs);

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{typed}</span>
      {withCursor ? (
        <span
          aria-hidden="true"
          className="ms-1 inline-block w-[3px] animate-pulse bg-[#d4af37] align-middle text-transparent motion-reduce:animate-none"
        >
          |
        </span>
      ) : null}
    </>
  );
}
```

Note: `useTypewriter`'s own defaults (`speedMs = 55`, `startDelayMs = 0`) apply when the props are omitted, so do not repeat those defaults here — passing `undefined` through is correct and keeps one source of truth.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- src/components/landing/TypedText.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the gates**

Run: `bun run lint && bun run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/TypedText.tsx src/components/landing/TypedText.test.tsx
git commit -m "perf(landing): confine hero typewriter state to a leaf component"
```

---

### Task 2: `CarouselDots` leaf component

**Files:**
- Create: `src/components/landing/CarouselDots.tsx`
- Test: `src/components/landing/CarouselDots.test.tsx`

**Interfaces:**
- Consumes: `type CarouselApi` from `@/components/ui/carousel`. The methods used are `on(event, handler)`, `off(event, handler)`, `scrollTo(index)`, and `selectedScrollSnap(): number`.
- Produces: `export function CarouselDots(props: CarouselDotsProps)` where
  ```ts
  type CarouselDotsProps = {
    api: CarouselApi | null;
    count: number;
    locale: Locale; // from @/i18n/dictionary, not a bare string
  };
  ```
  Task 3 renders `<CarouselDots api={carouselApi} count={slides.length} locale={locale} />`.

**Background the implementer needs.** The carousel auto-advances every 5 seconds while the tab is visible. Today the `select` handler sets `currentSlideIndex` in `LandingPage`, so the entire page re-renders ~12 times a minute, forever, in order to recolour a row of dots. `currentSlideIndex` is read nowhere else.

`locale` is passed as a prop rather than read from `useI18n()` so the component stays trivially testable — the existing `MessagePreviewPanel.test.tsx` has to mock the whole i18n provider, and this avoids that.

`api` is `null` on first render: the parent obtains it through the carousel's `setApi` callback, which fires after mount. The component must render the dots anyway and subscribe once the api arrives.

- [ ] **Step 1: Write the failing test**

Create `src/components/landing/CarouselDots.test.tsx`:

```tsx
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
      [...handlers.entries()].filter(([, set]) => set.size > 0).map(([event]) => event).sort(),
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun run test -- src/components/landing/CarouselDots.test.tsx`
Expected: FAIL — `Failed to resolve import "./CarouselDots"`.

- [ ] **Step 3: Write the component**

Create `src/components/landing/CarouselDots.tsx`:

```tsx
import { useEffect, useState } from "react";

import type { CarouselApi } from "@/components/ui/carousel";
import type { Locale } from "@/i18n/dictionary";

type CarouselDotsProps = {
  /** واجهة الكاروسيل، وتكون null حتى ينتهي التركيب الأول. */
  api: CarouselApi | null;
  /** عدد الشرائح، أي عدد النقاط المعروضة. */
  count: number;
  /** اللغة النشطة، لصياغة تسمية كل نقطة. */
  locale: Locale;
};

/**
 * يعرض نقاط التنقّل بين شرائح الكاروسيل ويُبرز النقطة النشطة.
 *
 * The active index lives here rather than in the page component on purpose:
 * the carousel auto-advances every five seconds, and holding this index any
 * higher re-rendered the whole landing page twelve times a minute, forever,
 * just to recolour these dots.
 */
export function CarouselDots({ api, count, locale }: CarouselDotsProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!api) return;

    /** يقرأ الشريحة النشطة الحالية من الكاروسيل ويحدّث النقطة المميّزة. */
    const syncFromApi = () => setActiveIndex(api.selectedScrollSnap());

    // Seed before subscribing: an api handed over mid-cycle is already past
    // slide 0, and waiting for the next `select` would show a stale dot.
    syncFromApi();

    // `reInit` as well as `select`, matching src/components/ui/carousel.tsx —
    // embla re-initialises when the slide set changes and does not reliably
    // emit `select` afterwards, which would leave every dot inactive once the
    // slides query refetches.
    api.on("select", syncFromApi);
    api.on("reInit", syncFromApi);

    return () => {
      api.off("select", syncFromApi);
      api.off("reInit", syncFromApi);
    };
  }, [api]);

  return (
    <div className="flex gap-1">
      {Array.from({ length: count }, (_, idx) => (
        <button
          type="button"
          key={idx}
          onClick={() => api?.scrollTo(idx)}
          aria-label={locale === "ar" ? `الشريحة ${idx + 1}` : `Slide ${idx + 1}`}
          aria-current={idx === activeIndex}
          className="py-2 px-0.5 cursor-pointer"
        >
          <span
            className={`block h-1.5 rounded-full transition-all duration-300 ${
              idx === activeIndex ? "w-8 bg-accent" : "w-2 bg-muted"
            }`}
          />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun run test -- src/components/landing/CarouselDots.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the gates**

Run: `bun run lint && bun run typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/landing/CarouselDots.tsx src/components/landing/CarouselDots.test.tsx
git commit -m "perf(landing): confine carousel slide index to a leaf component"
```

---

### Task 3: Wire both components into the landing page and make the scroll listener passive

**Files:**
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `TypedText` from Task 1 and `CarouselDots` from Task 2, with the exact prop shapes given in those tasks.
- Produces: nothing new. This task deletes state and swaps JSX.

**Important — read before editing.** All line numbers below refer to `src/routes/index.tsx` at commit `71ef454`, 2153 lines. Every anchor was verified to match the file byte-for-byte and to occur **exactly once**, so locate each edit by **searching for the quoted code**, not by jumping to a line number.

The steps are deliberately ordered **bottom-up**, and the order was verified against the file:

```text
1185 → 744 → 733 → 433 → 348 → 299 → 255 → 34
 dots  sub   title  effect  hook  scroll  state  imports
```

Every edit removes lines, so any other order shifts the anchors below it. **All import-block edits are deferred to step 7**, including removing the now-unused `useTypewriter` import, because the import block sits above everything else and touching it early moves every anchor. Follow the given order and the line numbers stay usable as a cross-check.

- [ ] **Step 1: Replace the dot row (around lines 1185-1202)**

Find this block:

```tsx
                  <div className="flex gap-1">
                    {slides.map((_, idx) => (
                      <button
                        type="button"
                        key={idx}
                        onClick={() => carouselApi?.scrollTo(idx)}
                        aria-label={locale === "ar" ? `الشريحة ${idx + 1}` : `Slide ${idx + 1}`}
                        aria-current={idx === currentSlideIndex}
                        className="py-2 px-0.5 cursor-pointer"
                      >
                        <span
                          className={`block h-1.5 rounded-full transition-all duration-300 ${
                            idx === currentSlideIndex ? "w-8 bg-accent" : "w-2 bg-muted"
                          }`}
                        />
                      </button>
                    ))}
                  </div>
```

Replace it with:

```tsx
                  <CarouselDots api={carouselApi} count={slides.length} locale={locale} />
```

- [ ] **Step 2: Replace the hero headings (around lines 733-745)**

**The subtitle comes first**, at line 744, because it sits *below* the title at 733 — replacing the title first would shift the subtitle's anchor up by six lines.

**2a — the subtitle (line 744).** Find this block, inside the `<p>`:

```tsx
                <span className="sr-only">{heroSubtitle}</span>
                <span aria-hidden="true">{typedHeroSubtitle}</span>
```

Replace it with:

```tsx
                <TypedText text={heroSubtitle} speedMs={22} startDelayMs={1500} />
```

**2b — the title (line 733).** Then find this block, above it, inside the `<h1>`:

```tsx
                <span className="sr-only">{heroTitle}</span>
                <span aria-hidden="true">{typedHeroTitle}</span>
                <span
                  aria-hidden="true"
                  className="ms-1 inline-block w-[3px] animate-pulse bg-[#d4af37] align-middle text-transparent motion-reduce:animate-none"
                >
                  |
                </span>
```

Replace it with:

```tsx
                <TypedText text={heroTitle} speedMs={90} withCursor />
```

Leave the surrounding `<h1>` and `<p>` elements and all their classes untouched.

- [ ] **Step 3: Delete the carousel `select` effect (lines 432-439)**

Delete this entire `useEffect`:

```tsx
    if (!carouselApi) return;
    const onSelect = () => setCurrentSlideIndex(carouselApi.selectedScrollSnap());
```

— that is, the whole effect whose dependency array is `[carouselApi]` and whose body subscribes to `"select"`. Do **not** touch the autoplay effect below it (the one with `window.setInterval(…, 5000)` and the five-element dependency array); it stays exactly as it is.

- [ ] **Step 4: Delete the two `useTypewriter` calls (lines 348-349)**

Delete exactly these two lines:

```tsx
  const typedHeroTitle = useTypewriter(heroTitle, 90);
  const typedHeroSubtitle = useTypewriter(heroSubtitle, 22, 1500);
```

Keep the `heroTitle` and `heroSubtitle` declarations immediately above them — they are still passed to `TypedText`.

Update the comment directly above those declarations, which currently reads:

```tsx
  // Hero headings type themselves in. The resolved strings are also rendered
  // sr-only below so crawlers and assistive tech always see the full title —
  // the animated copy starts empty and would otherwise be invisible to both.
```

to:

```tsx
  // Hero headings type themselves in; `TypedText` owns that animation and the
  // sr-only copy that keeps the full title visible to crawlers and assistive
  // tech while the animated span is still filling in.
```

**Do not remove the now-unused `useTypewriter` import yet.** It lives near the top of the file, and deleting it here would shift the anchors for steps 5 and 6. It is removed in step 7 with the other import work.

- [ ] **Step 5: Make the scroll listener passive (around line 299)**

Find:

```tsx
    window.addEventListener("scroll", handleScroll);
```

Replace with:

```tsx
    window.addEventListener("scroll", handleScroll, { passive: true });
```

Leave the `removeEventListener` call unchanged — `passive` is not part of the matching criteria for removal (only `capture` is), so the existing removal still works.

Add above the `handleScroll` declaration, replacing the existing `// Scroll event` comment:

```tsx
  // يتتبّع تمرير الصفحة لتبديل مظهر الشريط العلوي.
  //
  // Registered passive: the handler never calls preventDefault, and saying so
  // lets the browser commit the scroll frame without waiting on it.
```

- [ ] **Step 6: Delete the `currentSlideIndex` state (line 255)**

Delete exactly this line:

```tsx
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
```

Keep `carouselApi` (line 256) and all three `carousel*Active` states — they are still used by the autoplay effect.

Verify nothing else references the deleted state: `grep -n "currentSlideIndex" src/routes/index.tsx` must return nothing.

- [ ] **Step 7: All import edits (done LAST, because they shift every line below)**

Every change to the import block happens here, after all the body edits, so no earlier step moves an anchor.

**7a — remove the now-unused `useTypewriter` import.** Check first that no call site remains:

```bash
grep -n "useTypewriter" src/routes/index.tsx
```

That must print nothing at all after step 4. If it still prints a call site, stop — step 4 did not complete. Only once it prints nothing, delete the import line:

```tsx
import { useTypewriter } from "@/hooks/useTypewriter";
```

**7b — add the two new component imports**, alongside the other `@/components` imports:

```tsx
import { CarouselDots } from "@/components/landing/CarouselDots";
import { TypedText } from "@/components/landing/TypedText";
```

Match the file's existing import ordering convention — ESLint plus Prettier will flag it if the placement is wrong, and `bun run lint` in the next step catches that.

- [ ] **Step 8: Run the full gates**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all three clean. The whole suite, not just the two new files.

- [ ] **Step 9: Commit**

```bash
git add src/routes/index.tsx
git commit -m "perf(landing): stop the page re-rendering on typewriter and carousel ticks"
```

---

## Self-review notes

- **Spec coverage.** Defect 1 (typewriter) → Task 1 + Task 3 steps 2 and 4. Defect 2 (carousel) → Task 2 + Task 3 steps 1, 3 and 6. Defect 3 (passive listener) → Task 3 step 5. Spec goals 1-3 map to the two render-count tests and the passive registration; goal 4 (no a11y/SEO regression) maps to `TypedText` test 2 and the `CarouselDots` label/click tests.

### Codex adversarial review (round 1) — disposition

Codex reviewed committed `f35e803` and returned REJECT. It independently confirmed Q1 (all quoted anchors match byte-for-byte, exactly once), Q3 (a passive listener is still removable — `passive` is not part of the matching criteria), and Q4 (`slides` is guarded at `index.tsx:1119` and `locale` is in scope from `index.tsx:206`).

**Accepted and fixed:**

- **`reInit` subscription.** `src/components/ui/carousel.tsx:100-101` subscribes its own handler to both `reInit` and `select`, so `reInit` is selection-relevant. `CarouselDots` now subscribes and unsubscribes both, with a test covering it. This was a genuine latent bug — a slides refetch would have left every dot inactive.
- **Weak unsubscribe assertion.** `expect(off).toHaveBeenCalled()` passed for any `off` call, including the wrong event or a different handler. Replaced with an assertion against the stub's own subscription bookkeeping, which also catches a partial unsubscribe.
- **Missing Arabic doc comment** on `syncFromApi`.
- **Guards absent from the gate list.** Now stated in Global Constraints, along with who runs them.
- **Ordering.** Q5's finding (the "bottom-up" claim did not match the step sequence) had already been found and fixed independently before Codex reported; the steps now run strictly descending, with the imports last.

### Codex adversarial review (round 2) — disposition

Round 2 confirmed the round-1 fixes: the `reInit` subscribe/unsubscribe pair and its test genuinely prove resync (R1); the rewritten unsubscribe assertion does detect a partial unsubscribe and `subscribedEvents()` is correct (R2); the reworked stub introduces no new defect when one handler is bound to two events (R5); and both declines are defensible against the spec's stated non-goals (R4).

It rejected on ordering alone, with two objections, both accepted and fixed:

- **Step 2 replaced the title (733) before the subtitle (744)** — ascending inside a descending sequence, which would have shifted the subtitle's anchor by six lines. Split into 2a (subtitle) then 2b (title).
- **Step 4 removed the `useTypewriter` import** near the top of the file, shifting the anchors for steps 5 and 6. All import edits are now deferred to step 7.

The resulting order was then verified mechanically against `src/routes/index.tsx` rather than by inspection — each anchor's real line number, in step order, is strictly descending.

**Declined, with reasons:**

- **`useTypewriter` can commit one stale/partial render when `text` changes** (Q2). Correct, and pre-existing: `setTyped("")` runs in the effect, after paint. It is unchanged by this refactor — the same single frame occurs today — and the spec explicitly excludes changing the hook's behaviour. Logged for a separate change rather than smuggled into a performance PR.
- **`src/components/ui/carousel.tsx:103-105` leaks its `reInit` subscription.** A real bug, and Codex deserves credit for spotting it, but it is in the vendored shadcn component, is not touched by this change, and fixing it here would widen the diff into unrelated code. Logged separately.
- **Non-goals honoured.** No file split, no change to `useTypewriter`, no autoplay change, no memoization, no new dependency — all restated in Global Constraints.
- **Type consistency.** `TypedTextProps` and `CarouselDotsProps` are used with identical field names in Task 3. `CarouselApi` is imported from `@/components/ui/carousel` in both the component and the page, matching the existing import at `index.tsx:59`.
- **Known limitation of the render-count tests.** They cannot fail against "the pre-change code", because the components are new. Their value is as a regression gate: they fail if the animation state is ever hoisted back into a parent. That is stated in each test's docblock so a future reader does not mistake them for proof the original bug existed.
