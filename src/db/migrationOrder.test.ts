import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the migration naming/order contract that shell scripts must honour.
 *
 * scripts/test-db.sh and scripts/gen-types.sh apply migrations via
 * `ls … | sort -V` (numeric/version sort on the leading integer). A bare
 * shell glob sorts lexicographically, which puts `100_….sql` before
 * `50_….sql`. This test cannot execute those shell scripts — shell order is
 * proven only by `bun run test:sql` applying every migration cleanly.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");
const FILENAME_RE = /^\d+_[a-z0-9_]+\.sql$/;

function migrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

function leadingNumber(filename: string): number {
  return Number.parseInt(filename, 10);
}

describe("migration order contract", () => {
  it("every migration filename matches ^\\d+_[a-z0-9_]+\\.sql$", () => {
    const files = migrationFilenames();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f, `unexpected migration filename: ${f}`).toMatch(FILENAME_RE);
    }
  });

  it("no two migrations share a leading number (except known historical pairs)", () => {
    // Pre three-digit era: two pairs share a leading number. sort -V still
    // orders them deterministically by the rest of the filename, so apply
    // order is stable. New migrations must not reuse a number — that is what
    // this assertion enforces. Renaming the historical pairs is out of scope
    // (pinned names, structure tests, deploy history).
    const allowedDuplicates = new Map<number, string[]>([
      [16, ["16_admin_table_operations.sql", "16_custom_roles.sql"]],
      [39, ["39_rls_tenant_isolation_hardening.sql", "39_tenant_name_en_and_user_tenants.sql"]],
    ]);

    const files = migrationFilenames();
    const byNumber = new Map<number, string[]>();
    for (const f of files) {
      const n = leadingNumber(f);
      const list = byNumber.get(n) ?? [];
      list.push(f);
      byNumber.set(n, list);
    }

    const unexpected: Array<[number, string[]]> = [];
    for (const [n, names] of byNumber) {
      if (names.length < 2) continue;
      const sorted = [...names].sort();
      const allowed = allowedDuplicates.get(n);
      if (!allowed || sorted.join("\0") !== [...allowed].sort().join("\0")) {
        unexpected.push([n, sorted]);
      }
    }
    expect(
      unexpected,
      `unexpected duplicate leading numbers: ${JSON.stringify(unexpected)}`,
    ).toEqual([]);

    // Allowed pairs must still be present (typo-rename would silently drop them).
    for (const [n, expected] of allowedDuplicates) {
      const actual = [...(byNumber.get(n) ?? [])].sort();
      expect(actual).toEqual([...expected].sort());
    }
  });

  it("numeric sort of real filenames differs from lexicographic sort", () => {
    // If they ever coincide again (e.g. all numbers padded to the same width),
    // this assertion fails loudly and must be re-examined — the test would
    // otherwise become vacuous and no longer prove the 100-vs-50 class of bug.
    const files = migrationFilenames();
    const lex = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const numeric = [...files].sort((a, b) => leadingNumber(a) - leadingNumber(b));
    expect(numeric).not.toEqual(lex);
  });
});
