import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { dictionaries } from "./dictionary";

/**
 * Guards the translation catalog against the failure that shipped six broken
 * labels in Batches C–F.
 *
 * `t()` falls back to the raw key string, so a key nobody added renders as
 * literally "common.add" on screen — in both locales, with no error, no warning
 * and no failing test. `bun run lint`, `typecheck` and the whole unit suite
 * stayed green while the Add button on three screens read `common.add`.
 *
 * These checks are deliberately structural rather than a list of expected keys:
 * a hand-maintained list would drift exactly like the catalog did.
 */

const SOURCE_ROOT = join(import.meta.dirname, "..");

/** Source files that can call `t()`. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.(test|sqltest)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

const ALL_SOURCE = sourceFiles(SOURCE_ROOT).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

/** `t("some.key")` — the literal form, which must resolve exactly. */
function staticKeysIn(text: string): string[] {
  return [...text.matchAll(/\bt\("([a-zA-Z0-9_.]+)"\)/g)].map((match) => match[1]);
}

/**
 * `t(`some.prefix.${value}`)` — the interpolated form.
 *
 * The variant cannot be known statically, so the assertion is that the family
 * exists at all. That still catches a misspelled prefix, which otherwise fails
 * silently for every variant at once.
 */
function dynamicPrefixesIn(text: string): string[] {
  return [...text.matchAll(/\bt\(`([a-zA-Z0-9_.]+\.)\$\{/g)].map((match) => match[1]);
}

describe("locale parity", () => {
  test("ar and en define exactly the same keys", () => {
    // The stronger half of the guard: with parity held, any key proven to exist
    // in one locale exists in the other, so the checks below only need to test
    // one. A key added to en alone would otherwise render as the raw key in ar,
    // because DEFAULT_LOCALE is "ar" — the fallback resolves back to the locale
    // that is already missing it.
    const ar = Object.keys(dictionaries.ar).sort();
    const en = Object.keys(dictionaries.en).sort();
    expect(en.filter((key) => !dictionaries.ar[key])).toEqual([]);
    expect(ar.filter((key) => !dictionaries.en[key])).toEqual([]);
  });
});

describe("every key the UI asks for exists", () => {
  test('no t("literal") call resolves to a missing key', () => {
    const missing = ALL_SOURCE.flatMap(({ path, text }) =>
      staticKeysIn(text)
        .filter((key) => !(key in dictionaries.ar) || !(key in dictionaries.en))
        .map((key) => `${key}  (${path.replace(SOURCE_ROOT, "src")})`),
    );
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  test("every interpolated key family has at least one entry", () => {
    const arKeys = Object.keys(dictionaries.ar);
    const orphanPrefixes = ALL_SOURCE.flatMap(({ path, text }) =>
      dynamicPrefixesIn(text)
        .filter((prefix) => !arKeys.some((key) => key.startsWith(prefix)))
        .map((prefix) => `${prefix}*  (${path.replace(SOURCE_ROOT, "src")})`),
    );
    expect([...new Set(orphanPrefixes)].sort()).toEqual([]);
  });
});

describe("refund post-actions are translated for every variant", () => {
  // `post_action` is a closed enum in the database (migration 56), and both
  // families are addressed through `t(`…${postAction}`)`. The generic prefix
  // check above cannot see the variants, so this one names them.
  const POST_ACTIONS = ["store", "freeze", "archive"] as const;

  test.each(POST_ACTIONS)("refunds.postActionHint.%s exists in both locales", (action) => {
    expect(dictionaries.ar[`refunds.postActionHint.${action}`]).toBeTruthy();
    expect(dictionaries.en[`refunds.postActionHint.${action}`]).toBeTruthy();
  });

  test.each(POST_ACTIONS)("refunds.applied.%s exists in both locales", (action) => {
    expect(dictionaries.ar[`refunds.applied.${action}`]).toBeTruthy();
    expect(dictionaries.en[`refunds.applied.${action}`]).toBeTruthy();
  });
});

describe("invoiceState.waived meaning", () => {
  // waived MEANS written off (migration 86), and BOTH locales must say so.
  //
  // Parity cannot catch this: both keys exist, so the suite stays green while
  // the two locales name two different concepts. AR previously read
  // "متنازع عنها" (disputed/contested) — which migration 86 makes actively
  // wrong, because a dispute is now a separate nullable flag on invoices that
  // deliberately leaves state and balance alone. An Arabic user would have read
  // a written-off invoice as disputed: exactly the distinction the migration
  // exists to draw.
  test("both locales mean written off, not disputed", () => {
    expect(dictionaries.en["invoiceState.waived"]).toBe("Written off");
    expect(dictionaries.ar["invoiceState.waived"]).toBe("مشطوبة");
    expect(dictionaries.ar["invoiceState.waived"]).not.toContain("متنازع");
  });
});

describe("close-out wizard step labels", () => {
  // Generic prefix check only proves a family exists, not each variant.
  const STEPS = ["1", "2", "3", "4", "5", "6", "7"] as const;

  test.each(STEPS)("closeout.step.%s exists in both locales", (step) => {
    expect(dictionaries.ar[`closeout.step.${step}`]).toBeTruthy();
    expect(dictionaries.en[`closeout.step.${step}`]).toBeTruthy();
  });
});

describe("close-out outcomes are translated for every variant", () => {
  const OUTCOMES = ["keep_terminated", "freeze", "archive"] as const;

  test.each(OUTCOMES)("closeout.outcome.%s exists in both locales", (outcome) => {
    expect(dictionaries.ar[`closeout.outcome.${outcome}`]).toBeTruthy();
    expect(dictionaries.en[`closeout.outcome.${outcome}`]).toBeTruthy();
  });
});

describe("close-out invoice actions are translated for every variant", () => {
  const ACTIONS = ["leave", "settle_from_deposit", "write_off", "cancel", "mark_disputed"] as const;

  test.each(ACTIONS)("closeout.invoiceAction.%s exists in both locales", (action) => {
    expect(dictionaries.ar[`closeout.invoiceAction.${action}`]).toBeTruthy();
    expect(dictionaries.en[`closeout.invoiceAction.${action}`]).toBeTruthy();
  });
});

describe("close-out statuses are translated for every variant", () => {
  const STATUSES = ["draft", "completed", "cancelled"] as const;

  test.each(STATUSES)("closeout.status.%s exists in both locales", (status) => {
    expect(dictionaries.ar[`closeout.status.${status}`]).toBeTruthy();
    expect(dictionaries.en[`closeout.status.${status}`]).toBeTruthy();
  });
});

describe("close-out deduction kinds are translated for every variant", () => {
  const KINDS = ["damages", "cleaning", "utilities", "unpaid_rent", "other"] as const;

  test.each(KINDS)("closeout.deductionKind.%s exists in both locales", (kind) => {
    expect(dictionaries.ar[`closeout.deductionKind.${kind}`]).toBeTruthy();
    expect(dictionaries.en[`closeout.deductionKind.${kind}`]).toBeTruthy();
  });
});

describe("refund statuses are translated for every variant", () => {
  const STATUSES = ["draft", "posted", "voided", "reversed"] as const;

  test.each(STATUSES)("refunds.status.%s exists in both locales", (status) => {
    expect(dictionaries.ar[`refunds.status.${status}`]).toBeTruthy();
    expect(dictionaries.en[`refunds.status.${status}`]).toBeTruthy();
  });
});

describe("close-out notification types are translated for every variant", () => {
  const TYPES = ["contract_closeout", "contract_restored"] as const;

  test.each(TYPES)("notificationType.%s exists in both locales", (type) => {
    expect(dictionaries.ar[`notificationType.${type}`]).toBeTruthy();
    expect(dictionaries.en[`notificationType.${type}`]).toBeTruthy();
  });
});

describe("invoice event notification types are translated for every variant", () => {
  const TYPES = ["invoice_written_off", "invoice_disputed"] as const;

  test.each(TYPES)("notificationType.%s exists in both locales", (type) => {
    expect(dictionaries.ar[`notificationType.${type}`]).toBeTruthy();
    expect(dictionaries.en[`notificationType.${type}`]).toBeTruthy();
  });
});

describe("archive / dispute display labels", () => {
  test("Archived Contract / عقد مؤرشف", () => {
    expect(dictionaries.en["archive.archivedContract"]).toBe("Archived Contract");
    expect(dictionaries.ar["archive.archivedContract"]).toBe("عقد مؤرشف");
  });

  test("Restore to operational lists / إعادة إلى القوائم التشغيلية", () => {
    expect(dictionaries.en["archive.restore"]).toBe("Restore to operational lists");
    expect(dictionaries.ar["archive.restore"]).toBe("إعادة إلى القوائم التشغيلية");
  });

  test("Archived / مؤرشف", () => {
    expect(dictionaries.en["archive.badge"]).toBe("Archived");
    expect(dictionaries.ar["archive.badge"]).toBe("مؤرشف");
  });

  test("Disputed / متنازع عنها", () => {
    expect(dictionaries.en["invoice.disputed"]).toBe("Disputed");
    expect(dictionaries.ar["invoice.disputed"]).toBe("متنازع عنها");
  });
});

describe("scheduled / generated reports i18n (relocated to Workflows)", () => {
  // These sections moved from /admin/reports into Settings → Notifications →
  // Workflows. Keys must keep resolving in both locales so the pointer and the
  // section headings never fall back to raw key strings.
  const KEYS = [
    "reports.schedules",
    "reports.generated",
    "reports.schedulesMovedPrefix",
    "reports.schedulesMovedLink",
    "reports.schedulesMovedSuffix",
    "workflows.title",
  ] as const;

  test.each(KEYS)("%s resolves in ar and en", (key) => {
    expect(dictionaries.ar[key]).toBeTruthy();
    expect(dictionaries.en[key]).toBeTruthy();
  });

  test("pointer link strings are natural Arabic / English, not identical", () => {
    expect(dictionaries.en["reports.schedulesMovedLink"]).toBe(
      "Settings → Notifications → Workflows",
    );
    expect(dictionaries.ar["reports.schedulesMovedLink"]).toBe("الإعدادات ← الإشعارات ← سير العمل");
    expect(dictionaries.ar["reports.schedulesMovedLink"]).not.toBe(
      dictionaries.en["reports.schedulesMovedLink"],
    );
  });
});

describe("contracts.commercialActivity labels", () => {
  // Free-text catalogue field (migration 99). Both locales must exist and
  // must not be identical copy — parity alone would pass if both said
  // "Commercial activity".
  test("label exists in ar and en and differs", () => {
    expect(dictionaries.ar["contracts.commercialActivity"]).toBe("النشاط التجاري");
    expect(dictionaries.en["contracts.commercialActivity"]).toBe("Commercial activity");
    expect(dictionaries.ar["contracts.commercialActivity"]).not.toBe(
      dictionaries.en["contracts.commercialActivity"],
    );
  });

  test("placeholder exists in ar and en and differs", () => {
    expect(dictionaries.ar["contracts.commercialActivityPlaceholder"]).toBe("اختر النشاط التجاري");
    expect(dictionaries.en["contracts.commercialActivityPlaceholder"]).toBe(
      "Select commercial activity",
    );
    expect(dictionaries.ar["contracts.commercialActivityPlaceholder"]).not.toBe(
      dictionaries.en["contracts.commercialActivityPlaceholder"],
    );
  });
});

describe("units.floor labels", () => {
  // Free-text catalogue field (migration 101). Floor option labels live in the
  // database, not the dictionary — only the field chrome is translated here.
  test("label exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.floor"]).toBe("الطابق");
    expect(dictionaries.en["units.floor"]).toBe("Floor");
    expect(dictionaries.ar["units.floor"]).not.toBe(dictionaries.en["units.floor"]);
  });

  test("placeholder exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.floorPlaceholder"]).toBe("اختر الطابق");
    expect(dictionaries.en["units.floorPlaceholder"]).toBe("Select floor");
    expect(dictionaries.ar["units.floorPlaceholder"]).not.toBe(
      dictionaries.en["units.floorPlaceholder"],
    );
  });
});

describe("units.commercialCount and units.shopCount labels", () => {
  test("commercialCount exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.commercialCount"]).toBe("الوحدات التجارية");
    expect(dictionaries.en["units.commercialCount"]).toBe("Commercial units");
    expect(dictionaries.ar["units.commercialCount"]).not.toBe(
      dictionaries.en["units.commercialCount"],
    );
  });

  test("shopCount exists in ar and en and differs", () => {
    expect(dictionaries.ar["units.shopCount"]).toBe("المحلات");
    expect(dictionaries.en["units.shopCount"]).toBe("Shop units");
    expect(dictionaries.ar["units.shopCount"]).not.toBe(dictionaries.en["units.shopCount"]);
  });
});
