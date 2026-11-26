import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { insertInquiry, notify } = vi.hoisted(() => ({
  insertInquiry: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => {
  const serverFn: any = ({ data }: any) => serverFn._handler({ data });
  serverFn.validator = vi.fn().mockReturnValue(serverFn);
  serverFn.handler = vi.fn().mockImplementation((handler: any) => {
    serverFn._handler = handler;
    return serverFn;
  });
  return { createServerFn: vi.fn().mockReturnValue(serverFn) };
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://example.test/contact"),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: () => ({
        select: () => ({ single: insertInquiry }),
      }),
    }),
  },
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({ single: insertInquiry }),
      }),
    }),
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/fns/notifyContactInquiry", () => ({
  notifyContactInquiryRecord: (...args: unknown[]) => notify(...args),
}));

import { contactSchema } from "@/fns/submitContactInquiry";
import { submitContactInquiry } from "@/fns/submitContactInquiry";

/**
 * These assert the zod schema directly rather than calling the server function.
 *
 * The repo's server-fn tests mock `createServerFn` with a stub `.validator()`,
 * so validation never executes on that path — a test that submitted a filled
 * honeypot through `submitContactInquiry` would "pass" against a schema with no
 * honeypot at all. Parsing the exported schema is what makes the assertion real.
 */

const valid = {
  name: "Sara",
  email: "sara@example.com",
  phone: "+96550000000",
  subject: "General request",
  message: "Do you have retail space available?",
};

const INQUIRY_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  insertInquiry.mockResolvedValue({ data: { id: INQUIRY_ID }, error: null });
  notify.mockResolvedValue({ skipped: false, notification: { id: "notification-1" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("contactSchema", () => {
  test("accepts a well-formed submission", () => {
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  test("accepts an absent or empty honeypot", () => {
    expect(contactSchema.safeParse({ ...valid, website: "" }).success).toBe(true);
    expect(contactSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects a filled honeypot", () => {
    // A bot fills every field it can see, including the hidden one.
    const result = contactSchema.safeParse({ ...valid, website: "https://spam.example" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "website")).toBe(true);
    }
  });

  test("rejects a honeypot holding only whitespace", () => {
    // max(0) is length-based, so " " is caught without a trim() step.
    expect(contactSchema.safeParse({ ...valid, website: " " }).success).toBe(false);
  });

  test("requires name, email and message", () => {
    expect(contactSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(contactSchema.safeParse({ ...valid, message: "" }).success).toBe(false);
    expect(contactSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  test("treats phone and subject as optional", () => {
    const { phone: _phone, subject: _subject, ...withoutOptionals } = valid;
    expect(contactSchema.safeParse(withoutOptionals).success).toBe(true);
    expect(contactSchema.safeParse({ ...valid, phone: null, subject: null }).success).toBe(true);
  });
});

describe("submitContactInquiry", () => {
  test("a notification failure does not fail a stored inquiry", async () => {
    notify.mockRejectedValueOnce(new Error("smtp down"));

    const result = await submitContactInquiry({ data: valid });

    expect(notify).toHaveBeenCalledWith(INQUIRY_ID);
    expect(result).toMatchObject({ success: true });
  });
});
