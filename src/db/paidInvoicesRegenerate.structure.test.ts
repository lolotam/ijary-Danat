import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "db/migrations/95_never_touch_paid_invoices_on_regenerate.sql"),
  "utf8",
);

describe("migration 95 never touch paid invoices on regenerate", () => {
  test("skips paid and partially_paid before should_exist", () => {
    // Settled money must be evaluated first so out-of-range paid rows never
    // fall into the cancel/delete branch.
    const paidGuard = migration.indexOf("state in ('paid', 'partially_paid')");
    const shouldExist = migration.indexOf("v_should_exist :=");
    expect(paidGuard).toBeGreaterThanOrEqual(0);
    expect(shouldExist).toBeGreaterThan(paidGuard);
  });

  test("does not cancel paid invoices in the out-of-range branch via paid path", () => {
    // The paid skip uses continue before the else that sets cancelled.
    expect(migration).toMatch(/action := 'skipped'/);
    expect(migration).toMatch(/continue;/);
  });
});
