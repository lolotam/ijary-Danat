import { describe, expect, test, vi } from "vitest";

// createFileRoute is stubbed so `Route` IS its options object and
// validateSearch can be called as the pure function it is — no router, no
// component mount. Everything else stays real.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => options,
}));

const { Route } = await import("./admin.invoices");

/**
 * دالة تحقق عنوان الصفحة كما تُعرَّف في المسار، معزولة عن الراوتر.
 */
const validateSearch = (
  Route as unknown as {
    validateSearch: (search: Record<string, unknown>) => { property?: string };
  }
).validateSearch;

describe("admin.invoices validateSearch", () => {
  test("accepts a property id with the 8-4-4-4-12 uuid structure", () => {
    expect(validateSearch({ property: "0b8c7f1e-1111-2222-3333-444455556666" }).property).toBe(
      "0b8c7f1e-1111-2222-3333-444455556666",
    );
  });

  test("drops a malformed property instead of threading it to the filters", () => {
    expect(validateSearch({ property: "x" }).property).toBeUndefined();
    // 36 characters, but not hex in the 8-4-4-4-12 shape — a loose pattern
    // would let it reach Supabase as a filter value.
    expect(
      validateSearch({ property: "zzzzzzzz-1111-2222-3333-444455556666" }).property,
    ).toBeUndefined();
    expect(validateSearch({}).property).toBeUndefined();
  });
});
