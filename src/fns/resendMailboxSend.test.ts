import { describe, expect, it } from "vitest";

import { resendMailboxSendSchema } from "@/fns/resendMailboxSend";

/**
 * المخطّط يُختبر مباشرة لا عبر المعالج.
 *
 * The shared `createServerFn` test double skips `.validator()`, so a schema
 * asserted only through the handler never actually runs and every one of these
 * cases would pass vacuously.
 */
describe("resendMailboxSendSchema", () => {
  const base = {
    from: "no-reply@danat-future.com",
    to: ["tenant@example.com"],
    subject: "Rent invoice",
    body: "Body",
  };

  it("accepts a Bcc-only message", () => {
    // Exactly the shape "send to all tenants" produces. Requiring a visible
    // recipient would reject a legitimate send.
    const parsed = resendMailboxSendSchema.parse({
      from: base.from,
      bcc: ["a@example.com", "b@example.com"],
      subject: "Notice",
    });
    expect(parsed.bcc).toHaveLength(2);
    expect(parsed.to).toEqual([]);
  });

  it("rejects a message with no recipient of any kind", () => {
    expect(() =>
      resendMailboxSendSchema.parse({ from: base.from, subject: "Notice" }),
    ).toThrowError();
  });

  it("rejects a message with neither subject nor body", () => {
    expect(() =>
      resendMailboxSendSchema.parse({ from: base.from, to: ["a@example.com"] }),
    ).toThrowError();
  });

  it("rejects a malformed sender address", () => {
    expect(() => resendMailboxSendSchema.parse({ ...base, from: "not-an-address" })).toThrowError();
  });

  it("rejects a malformed recipient address", () => {
    expect(() => resendMailboxSendSchema.parse({ ...base, to: ["nope"] })).toThrowError();
  });

  it("defaults the optional collections rather than leaving them undefined", () => {
    const parsed = resendMailboxSendSchema.parse(base);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.attachments).toEqual([]);
  });

  it("accepts a subject with no body when html carries the content", () => {
    const parsed = resendMailboxSendSchema.parse({
      from: base.from,
      to: base.to,
      subject: "",
      html: "<p>Hello</p>",
    });
    expect(parsed.html).toBe("<p>Hello</p>");
  });
});
