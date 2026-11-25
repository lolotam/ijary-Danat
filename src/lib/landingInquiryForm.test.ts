/**
 * نموذج الاستفسار العام يرفض ما سيرفضه الخادم، ويقبل ما سيقبله.
 *
 * Regression for audit M23: the form carried its own schema with no length
 * caps, so a general request whose appended details pushed the message past
 * 2,000 characters passed the form and failed on the server.
 */
import { describe, expect, it } from "vitest";

import { contactSchema } from "@/fns/submitContactInquiry";
import { leasingSchema } from "@/fns/submitLeasingInquiry";
import {
  landingInquirySchema,
  toContactInquiry,
  toLeasingInquiry,
  type LandingInquiryValues,
} from "@/lib/landingInquiryForm";

const base: LandingInquiryValues = {
  name: "Visitor",
  request_type: "general",
  company_name: "Acme Retail",
  business_activity: "Coffee",
  phone: "+96550123456",
  email: "visitor@example.com",
  preferred_size: "100 m2",
  preferred_contact_method: "whatsapp",
  message: "Looking for a corner unit.",
  consent: true,
  website: "",
};

function messageIssue(values: LandingInquiryValues) {
  const result = landingInquirySchema("en").safeParse(values);
  return result.success ? undefined : result.error.issues.find((i) => i.path[0] === "message");
}

describe("landingInquirySchema", () => {
  it("flags a general message that fits alone but overflows once the details are appended", () => {
    const values = { ...base, message: "x".repeat(1990) };

    expect(messageIssue(values)).toBeDefined();
    // Proof it is the server's rule being applied, not a stricter local one.
    expect(contactSchema.safeParse(toContactInquiry(values, "en", "s")).success).toBe(false);
  });

  it("accepts the same long message on a leasing request, which appends nothing", () => {
    const values = { ...base, request_type: "leasing" as const, message: "x".repeat(1990) };

    expect(landingInquirySchema("en").safeParse(values).success).toBe(true);
  });

  it("applies the server's field caps to the shared fields", () => {
    const result = landingInquirySchema("en").safeParse({ ...base, name: "n".repeat(201) });

    expect(result.success).toBe(false);
  });

  it("lets a filled honeypot through so the server's rejection reaches the visitor", () => {
    expect(landingInquirySchema("en").safeParse({ ...base, website: "bot" }).success).toBe(true);
  });
});

describe("form values → server payloads", () => {
  it.each(["ar", "en"] as const)(
    "a general request the form accepts is accepted by the contact endpoint (%s)",
    (locale) => {
      expect(landingInquirySchema(locale).safeParse(base).success).toBe(true);
      expect(contactSchema.safeParse(toContactInquiry(base, locale, "Subject")).success).toBe(true);
    },
  );

  it("a leasing request the form accepts is accepted by the leasing endpoint", () => {
    const values = { ...base, request_type: "leasing" as const };

    expect(landingInquirySchema("ar").safeParse(values).success).toBe(true);
    expect(leasingSchema.safeParse(toLeasingInquiry(values, "ar")).success).toBe(true);
  });
});
