import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { RENAME_REFUSED_LISTS, valueRenameLock } from "@/lib/optionListRenameRules";
import { UNIT_FLOOR_TYPE_BINDING } from "@/lib/unitFloorTypeBinding";

const MIGRATION_239 = readFileSync(
  resolve(process.cwd(), "db/migrations/239_option_list_value_rename.sql"),
  "utf8",
);

/** يستخرج القيم النصية المقتبسة من قائمة SQL مثل ('a','b'). */
function quotedValues(sqlList: string): string[] {
  return [...sqlList.matchAll(/'([^']+)'/g)].map((match) => match[1]!).sort();
}

/** يعيد نص القائمة الذي يلي نمطاً معيناً في الترحيلة 239، أو يفشل بوضوح. */
function sqlListAfter(pattern: RegExp): string {
  const match = MIGRATION_239.match(pattern);
  if (!match) throw new Error(`migration 239 no longer contains ${pattern}`);
  return match[1]!;
}

// The editor locks a value field for exactly the cases the RPC refuses. These
// tests read the migration so a new refused list or bound value added on one
// side only fails here instead of re-opening the "preview says 0, confirm
// fails in English" path the review found.
describe("rename rules stay in lockstep with migration 239", () => {
  test("the refused list codes equal the RPC's refused codes", () => {
    const sql = sqlListAfter(/if v_code in \(([\s\S]*?)\) then/);
    expect([...RENAME_REFUSED_LISTS].sort()).toEqual(quotedValues(sql));
  });

  test("the bound floors equal the SQL's bound unit_floors values", () => {
    const sql = sqlListAfter(/p_list_code = 'unit_floors' and p_value in \(([^)]*)\)/);
    expect(Object.keys(UNIT_FLOOR_TYPE_BINDING).sort()).toEqual(quotedValues(sql));
  });

  test("the bound unit types equal the SQL's bound unit_types values", () => {
    const sql = sqlListAfter(/p_list_code = 'unit_types' and p_value in \(([^)]*)\)/);
    expect(Object.values(UNIT_FLOOR_TYPE_BINDING).sort()).toEqual(quotedValues(sql));
  });
});

describe("valueRenameLock", () => {
  test.each([
    ["tenant_categories", "vip", "refusedList"],
    ["manual_payment_reasons", "any", "refusedList"],
    ["unit_statuses", "occupied", "refusedList"],
    ["unit_floors", "roof", "codeBound"],
    ["unit_types", "managemental-services", "codeBound"],
    ["unit_types", "advertise", null],
    ["kuwait_banks", "nbk", null],
  ])("%s / %s → %s", (listCode, value, expected) => {
    expect(valueRenameLock(listCode, value)).toBe(expected);
  });
});
