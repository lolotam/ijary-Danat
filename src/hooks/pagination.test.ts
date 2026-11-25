import { describe, expect, it } from "vitest";

import { clampPage, pageCount, pageRange } from "@/hooks/pagination";

describe("pageRange", () => {
  it("computes the first page (0-based inclusive range)", () => {
    expect(pageRange(1, 10)).toEqual({ from: 0, to: 9 });
  });

  it("computes the second page", () => {
    expect(pageRange(2, 10)).toEqual({ from: 10, to: 19 });
  });

  it("supports a custom page size", () => {
    expect(pageRange(3, 25)).toEqual({ from: 50, to: 74 });
  });

  it("guards non-positive inputs", () => {
    expect(pageRange(0, 10)).toEqual({ from: 0, to: 9 });
    expect(pageRange(-2, 10)).toEqual({ from: 0, to: 9 });
    expect(pageRange(1, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("pageCount", () => {
  it("returns 1 for an empty result", () => {
    expect(pageCount(0, 10)).toBe(1);
  });

  it("returns 1 when total is smaller than the page size", () => {
    expect(pageCount(7, 10)).toBe(1);
  });

  it("counts a final partially populated page", () => {
    expect(pageCount(21, 10)).toBe(3);
  });
});

describe("clampPage", () => {
  it("stays on page 1 when filters shrink the result", () => {
    expect(clampPage(1, 0, 10)).toBe(1);
  });

  it("moves back when the last record on the final page is deleted", () => {
    // Was page 3 of 3 (21 rows); after one delete, 20 rows → 2 pages.
    expect(clampPage(3, 20, 10)).toBe(2);
  });

  it("does not advance past the last page", () => {
    expect(clampPage(99, 25, 10)).toBe(3);
  });
});
