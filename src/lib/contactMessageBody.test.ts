import { describe, expect, test } from "vitest";

import { composeGeneralRequestMessage } from "@/lib/contactMessageBody";

/**
 * The regression these guard: the landing form's "General request" branch used
 * to send only name/email/phone/subject/message, silently dropping the four
 * other answers the same form collected.
 */

describe("composeGeneralRequestMessage", () => {
  test("keeps every answer the visitor gave", () => {
    const body = composeGeneralRequestMessage(
      {
        message: "Looking for a corner unit.",
        companyName: "Blue Door Co.",
        businessActivity: "Cafe",
        preferredSize: "50-100",
        preferredContactMethod: "whatsapp",
      },
      "en",
    );

    expect(body).toContain("Looking for a corner unit.");
    expect(body).toContain("Company: Blue Door Co.");
    expect(body).toContain("Business activity: Cafe");
    expect(body).toContain("Preferred size: 50-100");
    expect(body).toContain("Preferred contact method: WhatsApp");
  });

  test("labels are localized, and so is the contact method", () => {
    const body = composeGeneralRequestMessage(
      { message: "مرحبا", companyName: "شركة الباب الأزرق", preferredContactMethod: "phone" },
      "ar",
    );

    expect(body).toContain("الشركة: شركة الباب الأزرق");
    expect(body).toContain("طريقة التواصل المفضلة: هاتف");
  });

  test("an unrecognised contact method passes through verbatim", () => {
    // The <select> constrains the value today, but a hand-posted body must not
    // silently lose the answer.
    const body = composeGeneralRequestMessage({ preferredContactMethod: "telegram" }, "en");
    expect(body).toBe("Preferred contact method: telegram");
  });

  test("a message with no extra answers gains no separator", () => {
    expect(composeGeneralRequestMessage({ message: "Just this." }, "en")).toBe("Just this.");
  });

  test("blank and whitespace-only values are omitted, not rendered empty", () => {
    const body = composeGeneralRequestMessage(
      {
        message: "Hello",
        companyName: "   ",
        businessActivity: "",
        preferredSize: null,
        preferredContactMethod: undefined,
      },
      "en",
    );
    expect(body).toBe("Hello");
  });

  test("extra answers survive an empty message", () => {
    expect(composeGeneralRequestMessage({ message: "", companyName: "Acme" }, "en")).toBe(
      "Company: Acme",
    );
  });

  test("an entirely empty submission yields an empty string", () => {
    expect(composeGeneralRequestMessage({}, "en")).toBe("");
  });

  test("the visitor's own text comes first", () => {
    const body = composeGeneralRequestMessage({ message: "Body text", companyName: "Acme" }, "en");
    expect(body.indexOf("Body text")).toBeLessThan(body.indexOf("Company: Acme"));
  });
});
