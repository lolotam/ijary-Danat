import { describe, expect, it } from "vitest";

import { cardsByPage } from "@/lib/cardRegistry";

describe("CARD_REGISTRY portal page", () => {
  it("ends with the portal group and the portal flag ids", () => {
    const last = cardsByPage().at(-1);
    expect(last?.page).toBe("portal");
    expect(last?.cards.map((card) => card.id)).toEqual([
      "portal.reminderPopup",
      "portal.messageCompose",
      "portal.leaseConcessions",
      "portal.insurance",
      "portal.nextDue",
      "portal.overdueInvoices",
      "portal.totalOverdue",
    ]);
  });
});
