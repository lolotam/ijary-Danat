import { describe, expect, test } from "vitest";

import { canonicalizeCsvRows, localizeCsvHeader, localizeCsvRows } from "@/lib/csvHeaders";

/**
 * Arabic exports rename every column key to its Arabic label, and imports map
 * those labels back to the canonical key. That round trip only works while the
 * label map is injective — two keys sharing one Arabic label would make one of
 * them unreachable on import, silently dropping a column.
 *
 * The connected_* and active_contract_* keys are the ones at risk: their natural
 * labels are close to property_code / unit_code / start_date / end_date.
 */
const ROUND_TRIP_KEYS = [
  "code",
  "name",
  "property_code",
  "unit_code",
  "start_date",
  "end_date",
  "units",
  "connected_property_code",
  "connected_unit_code",
  "connected_property_name_ar",
  "connected_property_name_en",
  "connected_unit_name_ar",
  "connected_unit_name_en",
  "active_contract_start_date",
  "active_contract_end_date",
  // Multi-unit contract / multi-contract tenant export keys — must stay
  // injective against monthly_amount / start_date / end_date / contract_code.
  "unit_line_order",
  "unit_monthly_amount",
  "contract_index",
  "contract_code",
  "contract_state",
  "contract_start_date",
  "contract_end_date",
  "contract_monthly_amount",
  "monthly_amount",
  "owner_civil_id",
  "authorized_manager_civil_id",
  "commercial_address",
];

describe("csv header localization", () => {
  test("every Arabic label maps back to its own key", () => {
    for (const key of ROUND_TRIP_KEYS) {
      const label = localizeCsvHeader(key, "ar");
      const [restored] = canonicalizeCsvRows([{ [label]: "value" }]);
      expect(Object.keys(restored), `"${label}" (from ${key}) did not round-trip`).toEqual([key]);
    }
  });

  test("Arabic labels are distinct across the round-trip keys", () => {
    const labels = ROUND_TRIP_KEYS.map((key) => localizeCsvHeader(key, "ar"));
    expect(new Set(labels).size).toBe(ROUND_TRIP_KEYS.length);
  });

  test("English locale leaves keys untouched", () => {
    expect(localizeCsvHeader("connected_property_code", "en")).toBe("connected_property_code");
    expect(localizeCsvRows([{ connected_unit_code: "U-1" }], "en")).toEqual([
      { connected_unit_code: "U-1" },
    ]);
  });

  test("unknown keys fall back to the key itself rather than throwing", () => {
    expect(localizeCsvHeader("not_a_real_column", "ar")).toBe("not_a_real_column");
  });
});
