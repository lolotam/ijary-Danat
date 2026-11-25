import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(process.cwd(), "src/routes/admin.payments.tsx"), "utf8");

describe("payments KPI cards", () => {
  it("gates each card with the registry id, in the order the cards appear", () => {
    // Configuration that is stored and never read is this repo's recurring
    // defect. The ids must match cardRegistry.ts and the on-page order.
    const ids = [...SOURCE.matchAll(/isCardVisible\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(ids).toEqual([
      "payments.full",
      "payments.partial",
      "payments.insurance",
      "payments.refunds",
      "payments.net",
    ]);
  });
});
