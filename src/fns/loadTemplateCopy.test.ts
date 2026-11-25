import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }),
  },
}));

const { loadTemplateCopy } = await import("./loadTemplateCopy");

const ROW = {
  subject_ar: "إيصال {{code}}",
  subject_en: "Receipt {{code}}",
  body_ar: "<p>مرحبا {{name}}</p>",
  body_en: "<p>Hello {{name}}</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: ROW, error: null });
});

describe("loadTemplateCopy", () => {
  test("reads the column matching the locale", async () => {
    // What an admin edits under "Arabic" must be exactly what an Arabic
    // recipient receives — never the English column.
    const ar = await loadTemplateCopy("receipt-ar", "ar", { name: "أحمد", code: "R-1" });
    expect(ar.body).toBe("<p>مرحبا أحمد</p>");
    expect(ar.subject).toBe("إيصال R-1");

    const en = await loadTemplateCopy("receipt-en", "en", { name: "Ahmed", code: "R-1" });
    expect(en.body).toBe("<p>Hello Ahmed</p>");
  });

  test("a missing row returns nulls so the caller can fall back", async () => {
    // A deleted or inactive template must degrade to the built-in copy, never
    // to sending nothing.
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadTemplateCopy("gone", "en", {})).resolves.toEqual({
      subject: null,
      body: null,
      channel: null,
    });
  });

  test("a read error returns nulls rather than throwing", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(loadTemplateCopy("receipt-en", "en", {})).resolves.toEqual({
      subject: null,
      body: null,
      channel: null,
    });
  });

  test("values are escaped but the template's own markup is not", async () => {
    // A tenant named <script> must not inject through a placeholder, while the
    // admin's own <p> must survive.
    const out = await loadTemplateCopy("receipt-en", "en", {
      name: "<script>alert(1)</script>",
      code: "R-1",
    });
    expect(out.body).toContain("&lt;script&gt;");
    expect(out.body).not.toContain("<script>");
    expect(out.body).toContain("<p>");
  });

  test("an unknown placeholder survives verbatim", async () => {
    // A typo must be visible in the output, not a silent blank.
    const out = await loadTemplateCopy("receipt-en", "en", { code: "R-1" });
    expect(out.body).toContain("{{name}}");
  });

  test("the subject is NOT html-escaped", async () => {
    // A subject is a plain-text header, not markup. dispatchNotification hands
    // notification.subject straight to SMTP/Resend, so escaping here shipped a
    // literal "&amp;" to the recipient's inbox — and, because wrapLayout escapes
    // the title again for the branded header, a literal "&amp;amp;" there.
    //
    // The values that break it are the free-text ones: a deposit note, a refund
    // reason, the public contact form's name field, or a tenant called O'Brien.
    maybeSingle.mockResolvedValueOnce({
      data: {
        subject_ar: "إيداع {{name}}",
        subject_en: "Deposit {{code}} for {{name}}",
        body_ar: "<p>{{name}}</p>",
        body_en: "<p>{{name}}</p>",
      },
      error: null,
    });
    const out = await loadTemplateCopy("deposit-confirmation-en", "en", {
      code: "cash & cheque",
      name: "O'Brien",
    });
    expect(out.subject).toBe("Deposit cash & cheque for O'Brien");
  });

  test("the body is still escaped when the subject is not", async () => {
    // The two fields diverge on purpose. Proving them together stops a later
    // simplification from collapsing both back onto one map.
    const out = await loadTemplateCopy("receipt-en", "en", {
      name: "<b>x</b> & y",
      code: "R-1",
    });
    expect(out.subject).toContain("R-1");
    expect(out.body).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});
