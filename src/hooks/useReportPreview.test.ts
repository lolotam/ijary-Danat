import { describe, expect, it } from "vitest";

import { REPORT_PREVIEW_LIMIT } from "@/hooks/useReportPreview";

describe("REPORT_PREVIEW_LIMIT", () => {
  it("is an explicit positive preview cap (not silent unlimited)", () => {
    expect(REPORT_PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(REPORT_PREVIEW_LIMIT).toBe(100);
  });
});
