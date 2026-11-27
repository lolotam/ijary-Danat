import { beforeEach, describe, expect, test, vi } from "vitest";

import { TENANT_PAUSED_REASON } from "@/lib/tenantNotificationsPaused";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";

const invoiceRow = vi.fn();
const tenantRow = vi.fn();
const itemsRow = vi.fn();
const unitsRow = vi.fn();
const propertiesRow = vi.fn();
const companyRow = vi.fn();
const templateRow = vi.fn();
const enqueue = vi.fn();

const dbClient = {
  from: (table: string) => {
    if (table === "invoices") return { select: () => ({ eq: () => ({ single: invoiceRow }) }) };
    if (table === "tenants") return { select: () => ({ eq: () => ({ single: tenantRow }) }) };
    // invoice_items: `.select("unit_id").eq("invoice_id", …).not("unit_id", "is", null)`.
    if (table === "invoice_items") {
      return { select: () => ({ eq: () => ({ not: () => itemsRow() }) }) };
    }
    // units/properties are resolved through invoice_items now (migration 112
    // made invoices.unit_id nullable for consolidated invoices), via `.in(...)`.
    if (table === "units") return { select: () => ({ in: () => unitsRow() }) };
    if (table === "properties") return { select: () => ({ in: () => propertiesRow() }) };
    if (table === "companies") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: companyRow }) }),
      };
    }
    // notification_templates: `.eq("code").eq("is_active").maybeSingle()`.
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }) }) };
  },
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
}));

const renderPdf = vi.fn();

// Only the PDF renderer is mocked away — `loadTemplateCopy` and
// `renderTemplate` stay real so the stored-body → section → WhatsApp text
// path is exercised end to end.
vi.mock("@/lib/invoiceDocumentPdf", () => ({
  renderInvoiceDocumentPdf: (...args: unknown[]) => renderPdf(...args),
}));

const { createInvoiceSendHandler, sendInvoiceDocument } = await import("./documentsInvoice");

/** يبني الفاتورة لقنواتها — هذا هو العمل الذي ينفّذه معالج المهمة. */
const send = (channels: ("email" | "whatsapp")[]) =>
  sendInvoiceDocument(INVOICE_ID, channels, COMPANY_ID);

beforeEach(() => {
  vi.clearAllMocks();
  invoiceRow.mockResolvedValue({
    data: {
      id: "invoice-1",
      tenant_id: "tenant-1",
      unit_id: "unit-1",
      code: "INV-1",
      period_month: 8,
      period_year: 2026,
      issue_date: "2026-08-01",
      due_date: "2026-08-10",
      subtotal: 250,
      discount: 0,
      paid: 0,
      total: 250,
    },
    error: null,
  });
  tenantRow.mockResolvedValue({
    data: {
      id: "tenant-1",
      name: "Ahmed",
      email: "tenant@example.test",
      whatsapp: "+96550000000",
      mobile: null,
      preferred_language: "en",
    },
    error: null,
  });
  itemsRow.mockResolvedValue({ data: [{ unit_id: "unit-1" }], error: null });
  unitsRow.mockResolvedValue({
    data: [{ id: "unit-1", name: "Flat 12", property_id: "property-1" }],
    error: null,
  });
  propertiesRow.mockResolvedValue({
    data: [{ id: "property-1", name_ar: "برج دانة", name_en: "Danat Tower" }],
    error: null,
  });
  companyRow.mockResolvedValue({
    data: { name_ar: "د", name_en: "D", invoice_footer_ar: "شكراً", invoice_footer_en: "Thanks" },
  });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1", state: "sent" });
  renderPdf.mockResolvedValue(null);
});

describe("the stored template decides the invoice mail", () => {
  test("the template body reaches the email", async () => {
    // Proves the row is READ, not merely tagged via templateCode.
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR-MARKER</p>",
        body_en: "<p>EN-MARKER</p>",
      },
      error: null,
    });

    await send(["email"]);

    expect(enqueue.mock.calls[0]?.[0]?.body).toContain("EN-MARKER");
  });

  test("the WhatsApp leg is the same body flattened", async () => {
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>ar</p>",
        body_en: "<p>Invoice INV-1 &amp; due 2026-08-10</p>",
      },
      error: null,
    });

    await send(["whatsapp"]);

    // stripMarkup also decodes the entities the renderer introduced — WhatsApp
    // is plain text and would otherwise show a literal &amp;.
    expect(enqueue.mock.calls[0]?.[0]?.body).toBe("Invoice INV-1 & due 2026-08-10");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    templateRow.mockResolvedValue({ data: null, error: null });

    await send(["email", "whatsapp"]);

    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [arg] of enqueue.mock.calls) {
      expect((arg.body as string).length).toBeGreaterThan(0);
    }
  });
});

describe("a consolidated multi-unit invoice", () => {
  test("names every unit rather than picking the first", async () => {
    // invoices.unit_id is null on a consolidated invoice (migration 112); the
    // units come from invoice_items instead.
    itemsRow.mockResolvedValue({
      data: [{ unit_id: "unit-1" }, { unit_id: "unit-2" }],
      error: null,
    });
    unitsRow.mockResolvedValue({
      data: [
        { id: "unit-1", name: "Flat 12", property_id: "property-1" },
        { id: "unit-2", name: "Flat 13", property_id: "property-1" },
      ],
      error: null,
    });
    templateRow.mockResolvedValue({ data: null, error: null });

    await send(["email"]);

    expect(enqueue.mock.calls[0]?.[0]?.body).toContain("Flat 12, Flat 13");
  });
});

describe("the eligibility gate does not wrap automatic senders", () => {
  test("still enqueues a document_send notification", async () => {
    await send(["email"]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "document_send", templateCode: "invoice-document" }),
    );
  });
});

describe("a tenant whose notifications are paused", () => {
  test("the skipped channel is reported as paused, not as a failed send", async () => {
    // The row was born `skipped` with the pause reason: nothing was meant to
    // reach this tenant, so the channel must not be counted as a failure.
    enqueue.mockResolvedValue({
      id: "notification-1",
      state: "skipped",
      failure_reason: TENANT_PAUSED_REASON,
    });

    const result = await send(["email"]);

    expect(result.paused).toEqual(["email"]);
    expect(result.failed).toEqual([]);
  });
});

describe("the PDF attachment rides both channels", () => {
  test("both channels carry the PDF attachment keys when the render succeeds", async () => {
    renderPdf.mockResolvedValue({
      bucket: "report-documents",
      path: "invoice-documents/INV-1-x.pdf",
      displayName: "INV-1.pdf",
    });

    const result = await send(["email", "whatsapp"]);

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([args]) => args.channel).sort()).toEqual(["email", "whatsapp"]);
    expect(result.sent).toHaveLength(2);
    expect(result.pdfMissing).toBe(false);
    for (const [args] of enqueue.mock.calls) {
      expect(args.payload).toMatchObject({
        attachment_bucket: "report-documents",
        attachment_paths: ["invoice-documents/INV-1-x.pdf"],
        attachment_names: ["INV-1.pdf"],
      });
      expect(args.payload).not.toHaveProperty("attachment_missing");
    }
  });

  test("a failed render sends text only, with no attachment keys", async () => {
    renderPdf.mockResolvedValue(null);

    const result = await send(["email", "whatsapp"]);

    // The caller's toast reads this to warn instead of claiming a full send.
    expect(result.pdfMissing).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    for (const [args] of enqueue.mock.calls) {
      expect(args.payload).not.toHaveProperty("attachment_paths");
      // The row says the PDF is missing, so the log does not pass it for complete.
      expect(args.payload.attachment_missing).toEqual(["INV-1"]);
    }
  });

  test("a zero-discount invoice renders the stored body without the discount rows", async () => {
    // The stored body is wrapped in a {{#has_discount}} section (migration 201);
    // with no discount the section drops its rows before the WhatsApp text is
    // flattened. loadTemplateCopy and renderTemplate run for real here, and the
    // tenant reads Arabic — the invoice follows the tenant's own language.
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        preferred_language: "ar",
      },
      error: null,
    });
    renderPdf.mockResolvedValue(null);
    templateRow.mockResolvedValue({
      data: {
        body_ar:
          "<p>{{invoice_number}}</p>{{#has_discount}}<p>الخصم {{discount}}</p>{{/has_discount}}",
        body_en: null,
        subject_ar: "س",
        subject_en: null,
        channel: "both",
      },
      error: null,
    });

    await send(["whatsapp"]);

    const [args] = enqueue.mock.calls[0];
    expect(args.body).toBe("INV-1");
    expect(args.body).not.toContain("الخصم");
  });
});

describe("the invoice.send handler", () => {
  test("renders the document for the channel in the payload and reports the outcome", async () => {
    const handler = createInvoiceSendHandler();

    const result = await handler({
      jobRequestId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_ID,
      payload: { invoiceId: INVOICE_ID, channel: "email" },
      attempt: 1,
    });

    // The handler writes the notification row and leaves the delivery to the
    // notify worker: one row for the channel the payload named.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]?.channel).toBe("email");
    expect(result).toMatchObject({ invoiceId: INVOICE_ID, channel: "email" });
  });

  test("writes one row per run, because an admin may resend on purpose", async () => {
    const handler = createInvoiceSendHandler();
    const context = {
      jobRequestId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_ID,
      payload: { invoiceId: INVOICE_ID, channel: "email" },
      attempt: 1,
    };

    await handler(context);
    await handler(context);

    // There is no sent marker on an invoice send, so a second run sends again:
    // the admin asked for it.
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
