/**
 * @vitest-environment jsdom
 *
 * The optimistic toggle has to be tested against a real QueryClient cache:
 * what matters is which cache entries change while the server call is still
 * pending, and what is restored when it fails. Same jsdom + createRoot
 * technique as admin.settings.cards.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// The module graph pulls @/fns/audit (via @/lib/audit) whose createServerFn
// must not run in a jsdom test — same mock shape as every src/fns test.
vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => {
    return fn._handler({ data, context: fn._context });
  };
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: unknown) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: unknown) => middlewareFn),
    }),
  };
});

// supabase.from("landing_media").update().eq().select().single() is the only
// chain the mutation walks; `single` is swapped per test to a deferred promise
// so the pending window — where the optimistic write must already be visible —
// is observable.
const single = vi.fn<() => Promise<{ data: unknown; error: unknown }>>();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => ({ single: () => single() }),
        }),
      }),
    }),
  },
}));

import type { LandingMedia } from "@/hooks/useLandingSettings";
import { useUpdateLandingMedia } from "@/hooks/useLandingSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * صف وسائط واحد بكل حقول الجدول، بمعرّف وفئة قابلين للتجاوز.
 */
function row(id: string, category: LandingMedia["category"], show: boolean): LandingMedia {
  return {
    id,
    storage_path: `landing/${id}.jpg`,
    mime_type: "image/jpeg",
    width: 800,
    height: 600,
    alt_ar: null,
    alt_en: null,
    caption_ar: null,
    caption_en: null,
    focal_x: 0.5,
    focal_y: 0.5,
    category,
    show_in_gallery: show,
    is_active: true,
    display_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const galleryRow = row("m1", "gallery", true);
const otherGalleryRow = row("m2", "gallery", false);
const logoRow = row("m3", "logo", false);

/**
 * يهيّئ مخزن الاستعلامات بكياني "landing_media": القسم المصفّى والقائمة
 * غير المصفّاة — الصف الواحد يقع فيهما معًا، وهذا هو سبب البادئة المشتركة.
 */
function seedCache(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<LandingMedia[]>(
    ["landing_media", "gallery"],
    [galleryRow, otherGalleryRow],
  );
  // The unfiltered list useLandingMedia() produces — key ["landing_media", undefined].
  queryClient.setQueryData<LandingMedia[]>(
    ["landing_media", undefined],
    [galleryRow, otherGalleryRow, logoRow],
  );
  return queryClient;
}

/**
 * يركّب زرًّا يشغّل الطفرة؛ يُعيد دالتَي start (تشغيل دون انتظار الردّ)
 * وdone (وعد يُحلّ عند انتهاء الطفرة نجاحًا أو فشلًا).
 *
 * `start` must not await the mutation: the test has to observe the cache in
 * the window where the server call is still pending.
 */
function mountHarness(queryClient: QueryClient): {
  root: Root;
  container: HTMLDivElement;
  start: () => Promise<void>;
  done: Promise<void>;
} {
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  function Harness() {
    const updateMedia = useUpdateLandingMedia();
    return (
      <button
        onClick={() => {
          updateMedia
            .mutateAsync({ id: "m1", updates: { show_in_gallery: false } })
            .then(settle, settle);
        }}
      >
        go
      </button>
    );
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
  });
  return {
    root,
    container,
    start: async () => {
      await act(async () => {
        container.querySelector("button")!.click();
      });
    },
    done,
  };
}

/** يؤجّل ردّ الخادم حتى يُستدعى صراحةً، ليكشف نافذة "قيد التنفيذ". */
function deferredServer() {
  let resolve!: (value: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((r) => {
    resolve = r;
  });
  single.mockReturnValue(promise);
  return resolve;
}

/**
 * يقرأ علم الظهور لصف واحد من قسم مخبّأ محدّد، أو undefined إن غاب القسم.
 */
function cachedFlag(queryClient: QueryClient, key: readonly unknown[], id: string) {
  return queryClient.getQueryData<LandingMedia[]>(key)?.find((r) => r.id === id)?.show_in_gallery;
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  while (mounted.length) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe("useUpdateLandingMedia's optimistic update", () => {
  it("flips the row in every cached landing_media partition while the server is pending", async () => {
    const queryClient = seedCache();
    const resolveServer = deferredServer();
    const harness = mountHarness(queryClient);
    mounted.push(harness);

    await harness.start();

    // The pending window: server call has not answered, cache must already
    // show the toggle — in BOTH partitions, which is why the write is keyed
    // on the ["landing_media"] prefix rather than one category.
    expect(cachedFlag(queryClient, ["landing_media", "gallery"], "m1")).toBe(false);
    expect(cachedFlag(queryClient, ["landing_media", undefined], "m1")).toBe(false);
    expect(cachedFlag(queryClient, ["landing_media", "gallery"], "m2")).toBe(false);

    resolveServer({ data: { ...galleryRow, show_in_gallery: false }, error: null });
    await act(async () => {
      await harness.done;
    });
  });

  it("restores the snapshot when the write fails", async () => {
    const queryClient = seedCache();
    const resolveServer = deferredServer();
    const harness = mountHarness(queryClient);
    mounted.push(harness);

    await harness.start();
    resolveServer({ data: null, error: { message: "boom" } });
    await act(async () => {
      await harness.done;
    });

    expect(cachedFlag(queryClient, ["landing_media", "gallery"], "m1")).toBe(true);
    expect(cachedFlag(queryClient, ["landing_media", undefined], "m1")).toBe(true);
  });

  it("rolls back only its own row, leaving a concurrent toggle's pending write alone", async () => {
    const queryClient = seedCache();
    const resolveServer = deferredServer();
    const harness = mountHarness(queryClient);
    mounted.push(harness);

    await harness.start();

    // A second toggle, still in flight, has optimistically flipped a different
    // row. Restoring a whole snapshot on failure below would wipe this out and
    // it would only reappear when its own request settled.
    queryClient.setQueryData<LandingMedia[]>(["landing_media", "gallery"], (rows) =>
      rows?.map((r) => (r.id === "m2" ? { ...r, show_in_gallery: true } : r)),
    );

    resolveServer({ data: null, error: { message: "boom" } });
    await act(async () => {
      await harness.done;
    });

    expect(cachedFlag(queryClient, ["landing_media", "gallery"], "m1")).toBe(true);
    expect(cachedFlag(queryClient, ["landing_media", "gallery"], "m2")).toBe(true);
  });

  it("invalidates the landing_media prefix once the mutation settles", async () => {
    const queryClient = seedCache();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const resolveServer = deferredServer();
    const harness = mountHarness(queryClient);
    mounted.push(harness);

    await harness.start();
    resolveServer({ data: { ...galleryRow, show_in_gallery: false }, error: null });
    await act(async () => {
      await harness.done;
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["landing_media"] });
  });
});
