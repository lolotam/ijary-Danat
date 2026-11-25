# Landing page render hygiene

**Date:** 2026-08-16
**Branch:** `perf/landing-render-hygiene`
**Scope:** `src/routes/index.tsx` and two new leaf components.

> **Every `index.tsx:NNN` reference below points at commit `71ef454`**, where the
> file was 2153 lines — the state *before* this change. The change itself moves
> them: `index.tsx` is 2118 lines afterwards. Use the quoted code, not the line
> number, to find anything in the current tree.

## Problem

`LandingPage` (`src/routes/index.tsx:205`–`2153`) holds three pieces of
transient state at the top of a ~1950-line component tree. Two of them change on
a timer, so every tick re-renders the entire public landing page — the hero, the
brand grid, the carousel, the filters, the map, the contact form.

This is the only page in the product that unauthenticated visitors load, and the
measured client payload for `/` is 343 KB gzip across 53 files (route manifest,
production build of 2026-08-16). The re-render cost lands on top of that, during
hydration, on mobile.

### Defect 1 — the hero typewriter (burst, ~2.6 s)

```ts
// index.tsx:348-349
const typedHeroTitle = useTypewriter(heroTitle, 90);
const typedHeroSubtitle = useTypewriter(heroSubtitle, 22, 1500);
```

`useTypewriter` calls `setTyped` once per character. Both values are consumed by
two `<span>`s inside the `<h1>`/`<p>` at `index.tsx:732`–`746`. Because the state
lives in `LandingPage`, each character re-renders the whole tree: roughly 13
ticks at 90 ms plus ~50 ticks at 22 ms — about **65 full-tree renders over
~2.6 seconds**, concurrent with hydration and image fetching.

### Defect 2 — the carousel dot indicators (permanent, ~12/minute)

```ts
// index.tsx:255
const [currentSlideIndex, setCurrentSlideIndex] = useState(0);

// index.tsx:432-439
const onSelect = () => setCurrentSlideIndex(carouselApi.selectedScrollSnap());
carouselApi.on("select", onSelect);

// index.tsx:452-453 — autoplay
const timer = window.setInterval(() => {
  if (document.visibilityState === "visible") carouselApi.scrollNext();
}, 5000);
```

`currentSlideIndex` is read in exactly one place — the dot indicators at
`index.tsx:1190`–`1197`. The carousel auto-advances every 5 s for as long as the
tab is visible, so the full page re-renders roughly **12 times a minute,
indefinitely**, to recolour a row of dots. This is strictly worse than defect 1,
which at least terminates.

### Defect 3 — non-passive scroll listener

```ts
// index.tsx:295-300
window.addEventListener("scroll", handleScroll);
```

`setScrolled(window.scrollY > 50)` is safe from a render standpoint — React bails
out when the boolean is unchanged, so it only re-renders on the threshold
crossing. The problem is the listener registration: without `{ passive: true }`
the browser must wait for the handler before committing a scroll frame, because
a non-passive listener is permitted to call `preventDefault()`. This one does
not, so the contract can be declared and the browser freed.

## Goals

1. `LandingPage` re-renders **once** for a full typewriter animation cycle.
2. `LandingPage` re-renders **zero** times when the carousel advances.
3. The scroll listener is registered passive.
4. No accessibility, SEO, or visual regression.

## Non-goals

- Splitting `index.tsx` to meet the 500–600 line ceiling. The file drops to
  2118 lines and remains over. A full split is a separate, larger piece of work.
- Changing `useTypewriter`'s behaviour. Its implementation is correct; only its
  call site was wrong.
- Changing the 5 s autoplay cadence, which is a product decision.
- Any bundle-size work (dictionary split, Supabase realtime). Assessed
  separately; both were judged not worth their risk right now.
- Introducing memoization (`React.memo`, `useMemo`) as the fix. Moving state down
  is the correct remedy; memoizing a 1950-line subtree would paper over it.

## Design

The single idea: **transient state moves down to the leaf that reads it.** No
component needs to memoize, because no component receives rapidly-changing props.

### `src/components/landing/TypedText.tsx`

Owns one `useTypewriter` call and renders the accessible pairing that
`index.tsx:732`–`746` builds by hand today.

```tsx
type TypedTextProps = {
  text: string;
  speedMs?: number;
  startDelayMs?: number;
  withCursor?: boolean;
};
```

Renders, in order:

1. `<span className="sr-only">{text}</span>` — the complete string, present from
   first paint.
2. `<span aria-hidden="true">{typed}</span>` — the animating copy.
3. when `withCursor`, the blinking caret span, `aria-hidden`, carrying the
   existing `animate-pulse motion-reduce:animate-none` classes.

**The `sr-only` + `aria-hidden` pairing is load-bearing and must be preserved
exactly.** The comment at `index.tsx:339`–`342` records why: the animated copy
starts empty, so without the `sr-only` sibling, crawlers and assistive
technology would see an empty `<h1>`. This is the highest-risk part of the
change and is pinned by test.

Consumers keep their own layout classes on the surrounding `<h1>`/`<p>`;
`TypedText` renders spans only and takes no `className`.

### `src/components/landing/CarouselDots.tsx`

Owns `currentSlideIndex` and the embla subscription.

```tsx
type CarouselDotsProps = {
  api: CarouselApi | null;
  count: number;
  locale: Locale; // from @/i18n/dictionary — the union, not a bare string
};
```

`locale` is a prop rather than a `useI18n()` call so the component stays
trivially testable; `MessagePreviewPanel.test.tsx` has to mock the whole i18n
provider, and this avoids that.

- Subscribes to **both** `api.on("select", …)` and `api.on("reInit", …)` in an
  effect keyed on `api`, unsubscribing from both on cleanup.

  The original effect at `index.tsx:432`–`439` listened only to `select`, but
  the shared carousel at `ui/carousel.tsx:100`–`101` binds its own handler to
  both, because embla re-initialises when the slide set changes and does not
  reliably emit `select` afterwards. Listening only to `select` would leave
  every dot inactive after the slides query refetches. This is a **behaviour
  change**, not part of the extraction, and is called out as such in the PR.
- Must tolerate `api === null` on first render: the parent sets `carouselApi`
  via `setApi`, so the first render always has `null`. It renders the dot row
  with index 0 active and subscribes once the api arrives.
- Seeds from `api.selectedScrollSnap()` when subscribing, so an api that is
  already past slide 0 does not display a stale active dot.
- Keeps the existing markup: `onClick={() => api?.scrollTo(idx)}`,
  `aria-current={idx === active}`, and the `w-8 bg-accent` / `w-2 bg-muted`
  class swap.

### `src/routes/index.tsx`

| Line(s) | Change |
|---|---|
| 348-349 | delete both `useTypewriter` calls |
| 732-746 | replace the four hand-built spans with two `<TypedText>` elements |
| 255 | delete the `currentSlideIndex` state |
| 432-439 | delete the `select` subscription effect |
| ~1185-1200 | replace the dot row with `<CarouselDots api={carouselApi} count={slides.length} locale={locale} />` |
| 299 | `window.addEventListener("scroll", handleScroll, { passive: true })` |

`heroTitle` and `heroSubtitle` (`index.tsx:343`–`347`) stay in `LandingPage` —
they derive from `settings` and are passed to `TypedText` as `text`.

## Testing

The repo has no `@testing-library`. Two existing tests establish the pattern this
work needs — a `@vitest-environment jsdom` docblock with raw `createRoot` and
`act()`: `src/auth/AuthProvider.test.tsx` and
`src/components/admin/landing-page/GalleryTable.test.tsx`. Follow them. Do not
add a testing library.

`vitest.config.ts` sets `environment: "node"` globally, so the per-file docblock
is required.

### The assertion that matters

**A parent render counter is the test.** A test that only asserts "the typed text
eventually appears" would pass just as well with the state hoisted back into the
page component, and so proves nothing. Each test mounts a parent that increments
a counter on every render and asserts the counter stays at 1 while the child
animates.

These are **regression guards, not proofs of the original bug.** `TypedText` and
`CarouselDots` do not exist before this change, so no test here can be run
against the pre-change code. What they pin is the property that motivated the
change: this state must never migrate back up into a parent.

They are also gates rather than measurements. Advancing every timer inside one
`act()` lets React batch the updates, so hoisting the state yields 2 renders,
not one per character — enough to fail `toBe(1)`, which is all that is required.
The ~65 renders that motivated the work happen because real `setInterval` ticks
arrive in separate macrotasks, which React does not batch across.

`src/components/landing/TypedText.test.tsx`

1. **Parent renders once.** Mount a counting parent around `<TypedText>`, advance
   fake timers through the full string, assert the child's text advanced and the
   parent counter is still 1.
2. **Full text present on first paint.** Before any timer advance, the rendered
   markup contains the complete `text` in the `sr-only` span, and the animated
   span is `aria-hidden="true"`.
3. **Reduced motion.** With `matchMedia("(prefers-reduced-motion: reduce)")`
   matching, the animated span holds the full string immediately, with no timer
   advance.

`src/components/landing/CarouselDots.test.tsx`

4. **Parent renders once.** Mount a counting parent with a fake api object,
   fire `select` several times, assert `aria-current` moved and the parent
   counter is still 1.
5. **Null api.** Renders `count` dots without throwing when `api` is `null`.
6. **Seeds from the api.** An api reporting `selectedScrollSnap() === 2` on
   subscribe marks the third dot current on first render.

The fake api is a small local stub (`on`/`off`/`scrollTo`/`selectedScrollSnap`)
— embla is not mocked as a module, and no internal helper of ours is mocked.

### Gates

`bun run lint`, `bun run typecheck`, `bun run test` all green, plus
`clean-code-guard` on the production code and `test-guard` on the tests, per
AGENTS.md.

## Conventions

Every function and component gets a doc comment **above** it whose first line is
an Arabic description, per AGENTS.md. English may follow for the *why*. This
applies to the two new components, their props types where non-obvious, and the
test helpers.

## Risks

| Risk | Mitigation |
|---|---|
| The `sr-only` / `aria-hidden` structure is dropped or reordered during extraction, silently costing the hero its crawler-visible title | Test 2 asserts both the full text and the `aria-hidden` attribute |
| `CarouselDots` throws on the first render, when `carouselApi` is still `null` | Test 5 |
| The dot row loses its click-to-slide behaviour in the move | `onClick` preserved verbatim; reviewed in the diff |
| A render-count test proves nothing because the counter is placed inside the child | The counter is in a **parent** wrapper, never inside the child. Confirmed by mutation instead of by pre-change comparison: hoisting the state into the parent makes the assertion fail |
