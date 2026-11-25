import { describe, expect, test } from "vitest";

import type { WhatsAppContactWithContracts } from "@/hooks/useWhatsAppInbox";

import { contactSortValue } from "./contactSortValue";

/**
 * يبني صف جهة اتصال حقيقياً بالحد الأدنى من الحقول، مع تجاوزات لكل اختبار.
 *
 * A real row rather than a mock: the comparator reads field names, and a mock
 * would keep passing after one of them is renamed out from under it.
 */
function contact(
  overrides: Partial<WhatsAppContactWithContracts> = {},
): WhatsAppContactWithContracts {
  return {
    id: "c1",
    phone: "96550000000",
    name: "محمد",
    commercial_name: null,
    email: null,
    notes: null,
    tenant_id: null,
    avatar_url: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    contracts: [],
    tenant: null,
    ...overrides,
  } as WhatsAppContactWithContracts;
}

describe("contactSortValue", () => {
  test("sorts the tenant column on the name the row actually shows", () => {
    const row = contact({ tenant: { id: "t1", name: "دانة", name_en: "Danat" } });
    expect(contactSortValue(row, "tenant", "ar")).toBe("دانة");
    expect(contactSortValue(row, "tenant", "en")).toBe("Danat");
  });

  test("an unlinked contact sorts as null so it lands at one end, not under 'null'", () => {
    expect(contactSortValue(contact(), "tenant", "ar")).toBeNull();
  });

  test("falls back to the Arabic name in English when no English name is stored", () => {
    const row = contact({ tenant: { id: "t1", name: "دانة", name_en: null } });
    expect(contactSortValue(row, "tenant", "en")).toBe("دانة");
  });

  test("sorts the contracts column by count, since codes have no defined order", () => {
    const row = contact({
      contracts: [
        { id: "1", code: "C-2" },
        { id: "2", code: "C-1" },
      ],
    });
    expect(contactSortValue(row, "contracts", "ar")).toBe(2);
  });

  test("reads every other column straight off the contact row", () => {
    const row = contact({ commercial_name: "مطعم", email: "a@b.test" });
    expect(contactSortValue(row, "commercial_name", "ar")).toBe("مطعم");
    expect(contactSortValue(row, "email", "ar")).toBe("a@b.test");
    expect(contactSortValue(row, "phone", "ar")).toBe("96550000000");
  });
});
