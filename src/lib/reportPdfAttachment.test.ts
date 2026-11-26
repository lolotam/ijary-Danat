import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn();
const list = vi.fn();
const renderHtmlToPdf = vi.fn();

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: (explicitCompanyId?: string) => ({
    companyId: explicitCompanyId ?? COMPANY_ID,
    client: { storage: { from: () => ({ list, upload }) } },
  }),
}));
vi.mock("@/lib/serverPdf", async () => {
  // wrapHtmlForPdf is pure and already covered by serverPdf.test.ts; using the
  // real one keeps this test honest about what actually reaches Chromium.
  const actual = await vi.importActual<typeof import("./serverPdf")>("./serverPdf");
  return {
    renderHtmlToPdf: (html: string) => renderHtmlToPdf(html),
    wrapHtmlForPdf: actual.wrapHtmlForPdf,
  };
});

const { attachmentPayload, renderAndStorePdf, REPORT_DOCUMENTS_BUCKET } =
  await import("./reportPdfAttachment");

const input = {
  arabic: false,
  discriminator: "2026-07-01_2026-07-31",
  html: "<h1>Monthly report</h1>",
  name: "Monthly summary",
  prefix: "scheduled-reports",
};

/** Storage answers "no such object", so every test renders unless it says otherwise. */
function bucketIsEmpty() {
  list.mockResolvedValue({ data: [], error: null });
}

/** Storage answers with exactly the object `renderAndStorePdf` asked about. */
function bucketHolds(path: string) {
  list.mockResolvedValue({ data: [{ name: path.slice(path.lastIndexOf("/") + 1) }], error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  renderHtmlToPdf.mockResolvedValue(Buffer.from("%PDF-1.4"));
  upload.mockResolvedValue({ data: { path: "x" }, error: null });
  bucketIsEmpty();
});

describe("renderAndStorePdf", () => {
  it("stores the rendered pdf and returns its bucket and path", async () => {
    const stored = await renderAndStorePdf(input);

    expect(stored).toEqual({
      bucket: REPORT_DOCUMENTS_BUCKET,
      path: expect.stringMatching(
        /^companies\/11111111-1111-4111-8111-111111111111\/scheduled-reports\/Monthly-summary-2026-07-01_2026-07-31-[0-9a-f]{12}\.pdf$/,
      ),
    });
    expect(upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/pdf" }),
    );
  });

  it("wraps the html so Chromium gets page geometry and a font stack", async () => {
    await renderAndStorePdf({ ...input, arabic: true });

    const rendered = renderHtmlToPdf.mock.calls[0][0] as string;
    expect(rendered).toContain('dir="rtl"');
    expect(rendered).toContain("@page");
    // Non-zero letter-spacing breaks Arabic glyph joining in print output.
    expect(rendered).toContain("letter-spacing: normal !important");
  });

  // A report whose PDF could not be produced must still reach its recipients as
  // HTML. Losing the attachment is a degradation; losing the report is an outage.
  it("returns null instead of throwing when Chromium fails", async () => {
    renderHtmlToPdf.mockRejectedValue(new Error("Failed to start Chromium"));

    await expect(renderAndStorePdf(input)).resolves.toBeNull();
  });

  it("returns null instead of throwing when the upload fails", async () => {
    upload.mockResolvedValue({ data: null, error: { message: "bucket missing" } });

    await expect(renderAndStorePdf(input)).resolves.toBeNull();
  });

  // Report names are frequently Arabic; a raw name would produce an unusable
  // storage key.
  it("builds an ascii-safe key from an arabic report name", async () => {
    const stored = await renderAndStorePdf({ ...input, name: "تقرير شهري" });

    expect(stored?.path).toMatch(
      /^companies\/11111111-1111-4111-8111-111111111111\/scheduled-reports\/[\w.-]+\.pdf$/,
    );
  });
});

describe("reusing an already-stored document", () => {
  // The point of the change: resending a report, or re-notifying a payment, used
  // to spawn Chromium to reproduce bytes already sitting in the bucket.
  it("returns the stored document without rendering it again", async () => {
    const first = await renderAndStorePdf(input);
    vi.clearAllMocks();
    bucketHolds(first!.path);

    const second = await renderAndStorePdf(input);

    expect(second).toEqual(first);
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  // The trap content-addressing exists to avoid: keyed on identity alone, the
  // stored copy would be reused for every later send, so a report first printed
  // in English would go out as the Arabic one.
  it.each([
    ["the locale changed", { arabic: true }],
    ["the document body changed", { html: "<h1>Monthly report v2</h1>" }],
  ])("renders a fresh document when %s", async (_scenario, change) => {
    const original = await renderAndStorePdf(input);
    bucketHolds(original!.path);
    renderHtmlToPdf.mockClear();

    const revised = await renderAndStorePdf({ ...input, ...change });

    expect(revised!.path).not.toEqual(original!.path);
    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
  });

  // A same-named object under a *different* key must not count as a hit.
  it("ignores a listing that does not contain the exact object", async () => {
    list.mockResolvedValue({
      data: [{ name: "Monthly-summary-2026-07-01_2026-07-31-000000.pdf" }],
      error: null,
    });

    await renderAndStorePdf(input);

    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
  });

  // Losing the attachment is worse than an unnecessary render, so a storage
  // error on the probe falls through to rendering rather than claiming a hit.
  it("renders when the storage lookup itself fails", async () => {
    list.mockResolvedValue({ data: null, error: { message: "bucket missing" } });

    const stored = await renderAndStorePdf(input);

    expect(stored).not.toBeNull();
    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
  });
});

describe("attachmentPayload", () => {
  it("produces the fields dispatchNotification reads", () => {
    expect(attachmentPayload({ bucket: "report-documents", path: "a/b.pdf" })).toEqual({
      attachment_bucket: "report-documents",
      attachment_paths: ["a/b.pdf"],
    });
  });

  // Spread into a payload, so it must contribute nothing at all when there is
  // no PDF — an empty attachment_paths array would still claim an attachment.
  it("is empty when there is no stored pdf", () => {
    expect(attachmentPayload(null)).toEqual({});
  });

  // A stored key ends in a payment id and a content hash, which is not a name a
  // tenant can match to the receipt they hold.
  it("carries the display names the dispatcher should attach under", () => {
    expect(
      attachmentPayload(
        [
          { bucket: "report-documents", path: "payment-receipts/REC-1-uuid-hash.pdf" },
          { bucket: "report-documents", path: "payment-receipts/REC-2-uuid-hash.pdf" },
        ],
        ["REC-1.pdf", "REC-2.pdf"],
      ).attachment_names,
    ).toEqual(["REC-1.pdf", "REC-2.pdf"]);
  });

  // Scheduled weekly and monthly reports pass no names and keep their stored
  // descriptive filenames — they are not receipts.
  it("omits the names entirely when the caller supplies none", () => {
    expect(attachmentPayload({ bucket: "report-documents", path: "a/b.pdf" })).not.toHaveProperty(
      "attachment_names",
    );
  });

  // Positional list: a short or gappy one would shift a receipt's name onto a
  // different tenant's document, so it is refused whole.
  it("refuses a partial name list rather than misnaming a file", () => {
    const payload = attachmentPayload(
      [
        { bucket: "report-documents", path: "a/one.pdf" },
        { bucket: "report-documents", path: "a/two.pdf" },
      ],
      ["REC-1.pdf"],
    );
    expect(payload).not.toHaveProperty("attachment_names");
    expect(payload.attachment_paths).toEqual(["a/one.pdf", "a/two.pdf"]);
  });
});
