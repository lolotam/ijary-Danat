import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const fn: {
    (input: { data: unknown; context: unknown }): unknown;
    _handler?: (args: { data: unknown; context: unknown }) => unknown;
    middleware: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn>;
  } = ((args: { data: unknown; context: unknown }) => fn._handler?.(args)) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: {},
}));

vi.mock("@/lib/gmailClient.server", () => ({
  describeGmailApiError: vi.fn(),
  getGmailAccessToken: vi.fn(),
  GMAIL_API: "https://gmail.example/v1",
  grantCanSend: vi.fn(),
  readGmailGrant: vi.fn(),
}));

const { buildMime, gmailSendSchema, plainTextFrom } = await import("./gmailSend");

/** يبني رسالة اختبارية بمستلم ظاهر وآخر مخفي. */
async function mimeWithBcc(): Promise<string> {
  const message = await buildMime({
    from: "office@example.com",
    to: ["visible@example.com"],
    bcc: ["hidden@example.com"],
    subject: "Notice",
    text: "Body",
  });
  return message.toString();
}

describe("buildMime", () => {
  it("emits a Bcc header", async () => {
    // Regression, found 2026-08-13. nodemailer's MimeNode drops Bcc from the
    // generated headers unless keepBcc is set (mime-node/index.js:581), and
    // MailComposer never sets it. That default is right for SMTP, where the
    // transport is handed the envelope recipients separately — but Gmail's
    // messages/send takes no envelope and delivers from the MIME headers alone.
    // So every Bcc address the compose dialog accepted was silently discarded:
    // no error, no bounce, no delivery.
    expect(await mimeWithBcc()).toMatch(/^Bcc: hidden@example\.com\s*$/m);
  });

  it("does not leak the Bcc recipient into the To header", async () => {
    // The point of Bcc is that the visible recipient cannot see it. Satisfying
    // the assertion above by merging everyone into To would be worse than the
    // bug it replaces.
    const mime = await mimeWithBcc();
    const toLine = mime.split(/\r?\n/).find((line) => line.startsWith("To:")) ?? "";

    expect(toLine).toContain("visible@example.com");
    expect(toLine).not.toContain("hidden@example.com");
  });

  it("omits the header entirely when there is no Bcc", async () => {
    const message = await buildMime({
      from: "office@example.com",
      to: ["visible@example.com"],
      subject: "Notice",
      text: "Body",
    });

    expect(message.toString()).not.toMatch(/^Bcc:/m);
  });
});

describe("gmailSendSchema", () => {
  it("accepts a bcc-only message", () => {
    // Select-all addresses every tenant via Bcc so none of them sees the others.
    // `to` used to be min(1), which rejected exactly that message.
    expect(() =>
      gmailSendSchema.parse({ bcc: ["a@x.com"], subject: "Notice", body: "Hi" }),
    ).not.toThrow();
  });

  it("rejects a message with no recipient anywhere", () => {
    expect(() => gmailSendSchema.parse({ subject: "Notice", body: "Hi" })).toThrow();
  });

  it("accepts a message whose only content is html", () => {
    // A rich-text send leaves `body` empty; the old refine called that empty.
    expect(() =>
      gmailSendSchema.parse({ to: ["a@x.com"], subject: "", body: "", html: "<p>Hi</p>" }),
    ).not.toThrow();
  });

  it("still rejects a message with a recipient but no content at all", () => {
    expect(() => gmailSendSchema.parse({ to: ["a@x.com"] })).toThrow();
  });

  it("carries the html alternative through", () => {
    const parsed = gmailSendSchema.parse({
      to: ["a@x.com"],
      subject: "Rent",
      body: "Plain",
      html: "<p>Rich</p>",
    });

    expect(parsed.html).toBe("<p>Rich</p>");
  });
});

describe("plainTextFrom", () => {
  it("strips markup so the Sent list does not show tags", () => {
    expect(plainTextFrom("<p>Hello <strong>there</strong></p>")).toBe("Hello there");
  });

  it("turns block boundaries into line breaks rather than running them together", () => {
    expect(plainTextFrom("<p>One</p><p>Two</p>")).toBe("One\nTwo");
  });

  it("decodes the ampersand last so an escaped entity stays escaped", () => {
    // Decoding & first would turn &amp;lt; into a real "<" and reintroduce the
    // markup this function exists to remove.
    expect(plainTextFrom("<p>a &amp;lt; b</p>")).toBe("a &lt; b");
  });

  it("leaves a plain body untouched", () => {
    expect(plainTextFrom("Hello there")).toBe("Hello there");
  });
});
