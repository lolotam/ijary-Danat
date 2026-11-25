import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { SummaryCards } from "@/components/admin/SummaryCards";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SummaryCards", () => {
  test("renders children when loaded without error", () => {
    const markup = renderToStaticMarkup(
      <SummaryCards loading={false} error={null}>
        <div data-testid="card">ok</div>
      </SummaryCards>,
    );
    expect(markup).toContain("ok");
    expect(markup).toContain('data-testid="card"');
  });

  test("renders skeleton while loading", () => {
    const markup = renderToStaticMarkup(
      <SummaryCards loading={true} error={null}>
        <div data-testid="card">ok</div>
      </SummaryCards>,
    );
    expect(markup).not.toContain('data-testid="card"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("animate-pulse");
  });

  test("fails silently on error so the table beneath is never blanked", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = renderToStaticMarkup(
      <SummaryCards loading={false} error={new Error("rpc down")}>
        <div data-testid="card">ok</div>
      </SummaryCards>,
    );
    expect(markup).toBe("");
    expect(err).toHaveBeenCalled();
  });
});
