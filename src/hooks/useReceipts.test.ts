import { describe, expect, it } from "vitest";

import { RECEIPT_LIST_COLUMNS } from "@/hooks/useReceipts";

describe("RECEIPT_LIST_COLUMNS", () => {
  it("excludes the heavy html_snapshot field from list retrieval", () => {
    expect(RECEIPT_LIST_COLUMNS).not.toMatch(/\bhtml_snapshot\b/);
    expect(RECEIPT_LIST_COLUMNS).toMatch(/\bcode\b/);
    expect(RECEIPT_LIST_COLUMNS).toMatch(/\bpayment_id\b/);
    expect(RECEIPT_LIST_COLUMNS).toMatch(/\bamount\b/);
  });
});
