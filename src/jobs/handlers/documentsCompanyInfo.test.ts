import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CompanyInfoSendChoice } from "./documentsCompanyInfo";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
/** معرّف طلب المهمة الذي تعمل تحته الإرساليات — مفتاح التسليم مبني عليه. */
const JOB_REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const inserted: Array<Record<string, unknown>> = [];
const uploads: string[] = [];

const templateRow = vi.fn();
const priorDeliveries = vi.fn();
const notifyInsertSingle = vi.fn();
const rpc = vi.fn();

/**
 * مُعرّف صف إشعار صالح — كتالوج المهام لا يقبل إلا معرّفات UUID.
 */
function notificationIdFor(index: number): string {
  return `44444444-4444-4444-8444-44444444444${index}`;
}

const clientStub = {
  from: (table: string) => {
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: TENANT_ID,
                name: "أحمد",
                name_en: "Ahmed",
                email: "tenant@example.test",
                whatsapp: "+96550000000",
                mobile: null,
                preferred_language: "ar",
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "companies") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: COMPANY_ID,
                slug: "danat",
                status: "active",
                name_ar: "دانة",
                name_en: "Danat",
                logo_url: null,
                bank_logo_url: null,
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "notification_templates") {
      // No admin-edited copy unless a test asks for one: the sender falls back
      // to its built-in wording.
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: () => templateRow() }) }),
        }),
      };
    }
    if (table === "notifications") {
      return {
        // فحص صف التسليم السابق: `.select().eq().in().order()` ثم انتظار السلسلة.
        select: () => ({
          eq: () => ({
            in: () => ({ order: () => priorDeliveries() }),
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({ single: () => notifyInsertSingle(row) }),
          };
        },
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  },
  storage: {
    from: () => ({
      upload: async (path: string) => {
        uploads.push(path);
        return { data: { path }, error: null };
      },
    }),
  },
  rpc: (...args: unknown[]) => rpc(...args),
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => clientStub,
}));

const { createCompanyInfoSendHandler, sendCompanyInformation } =
  await import("./documentsCompanyInfo");

/**
 * اختيارات الموظف وقت الطلب، كما يحملها العامل في الحمولة.
 *
 * The channels and the language are the request's own choices; the handler
 * must send exactly what the payload says.
 */
function choice(overrides: Partial<CompanyInfoSendChoice> = {}): CompanyInfoSendChoice {
  return { channels: ["email", "whatsapp"], language: "ar", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  uploads.length = 0;
  templateRow.mockResolvedValue({ data: null, error: null });
  priorDeliveries.mockResolvedValue({ data: [], error: null });
  notifyInsertSingle.mockImplementation(async (row: Record<string, unknown>) => ({
    data: { ...row, id: notificationIdFor(inserted.length) },
    error: null,
  }));
  rpc.mockResolvedValue({ data: "job-1", error: null });
});
describe("sendCompanyInformation", () => {
  test("the WhatsApp row carries the same PDF as the email row", async () => {
    // Evolution sends `attachment_paths` as document parts, so withholding the
    // key from the WhatsApp leg meant the tenant got the summary but never the
    // bank-details document the button promises.
    await sendCompanyInformation(TENANT_ID, COMPANY_ID, choice(), JOB_REQUEST_ID);

    expect(uploads).toHaveLength(1);
    const [pdfPath] = uploads;
    expect(pdfPath).toMatch(
      new RegExp(`^companies/${COMPANY_ID}/company-info/${TENANT_ID}_\\d+\\.pdf$`),
    );

    const byChannel = Object.fromEntries(inserted.map((row) => [row.channel, row.payload]));
    expect(byChannel.email).toMatchObject({
      attachment_bucket: "company-documents",
      attachment_paths: [pdfPath],
    });
    expect(byChannel.whatsapp).toMatchObject({
      attachment_bucket: "company-documents",
      attachment_paths: [pdfPath],
    });
    // One dispatch job per row: the notify worker sends them, not this worker.
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "notification.dispatch",
      _payload: { notificationId: "44444444-4444-4444-8444-444444444441" },
      _dedupe_key: "notification.dispatch:44444444-4444-4444-8444-444444444441",
      _requested_by: null,
    });
  });

  test("the WhatsApp body is plain text addressed to the tenant's number", async () => {
    await sendCompanyInformation(TENANT_ID, COMPANY_ID, choice(), JOB_REQUEST_ID);

    expect(inserted).toHaveLength(2);
    const whatsapp = inserted.find((row) => row.channel === "whatsapp");
    expect(whatsapp).toMatchObject({
      recipient_address: "+96550000000",
      subject: null,
    });
    expect(String(whatsapp?.body)).not.toContain("<");
  });

  test("a template that allows only email leaves the WhatsApp leg out", async () => {
    templateRow.mockResolvedValue({
      data: {
        body_ar: null,
        body_en: null,
        channel: "email",
        subject_ar: null,
        subject_en: null,
      },
      error: null,
    });

    await sendCompanyInformation(TENANT_ID, COMPANY_ID, choice(), JOB_REQUEST_ID);

    expect(inserted.map((row) => row.channel)).toEqual(["email"]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each<[("email" | "whatsapp")[]]>([[["email"]], [["whatsapp"]], [["email", "whatsapp"]]])(
    "sends only the channels the request chose: %j",
    async (channels) => {
      await sendCompanyInformation(TENANT_ID, COMPANY_ID, choice({ channels }), JOB_REQUEST_ID);

      expect(inserted.map((row) => row.channel)).toEqual(channels);
      // One dispatch job per written row.
      expect(rpc).toHaveBeenCalledTimes(channels.length);
    },
  );

  test.each<["ar" | "en", string, string]>([
    ["en", "Company information", "Please find attached our company contact and bank details."],
    ["ar", "معلومات الشركة", "تجدون مرفقًا معلومات التواصل والتفاصيل البنكية لشركتنا."],
  ])(
    "sends in the language the request chose, not the tenant's (%s)",
    async (language, subject, intro) => {
      // The tenant's own language is Arabic; the payload asks for English, so
      // an English document proves the job followed the request's choice.
      await sendCompanyInformation(
        TENANT_ID,
        COMPANY_ID,
        choice({ channels: ["email"], language }),
        JOB_REQUEST_ID,
      );

      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({ channel: "email", locale: language, subject });
      expect(String(inserted[0]?.body)).toContain(intro);
    },
  );

  test.each([["email"], ["whatsapp"]] as const)(
    "the %s row is written under the job's delivery key",
    async (channel) => {
      await sendCompanyInformation(TENANT_ID, COMPANY_ID, choice(), JOB_REQUEST_ID);

      expect(inserted.find((row) => row.channel === channel)).toMatchObject({
        delivery_key: `${JOB_REQUEST_ID}:${channel}`,
      });
    },
  );

  test("a retry that finds the delivery already written reuses it and re-claims its dispatch", async () => {
    // صف التسليم الذي كتبته المحاولة السابقة هو العلامة: المهمة نفسها تعيد
    // صفوفها كما هي بلا صف ثانٍ — لكن صفه المعلّق يُعاد حجز تصريفه بنفس مفتاح
    // المنع (GR-003)، فمحاولة ماتت بين الإدراج والحجز لا تنتظر التصريف اليومي.
    priorDeliveries.mockResolvedValue({
      data: [{ id: "44444444-4444-4444-8444-444444444449", state: "queued" }],
      error: null,
    });

    const result = await sendCompanyInformation(
      TENANT_ID,
      COMPANY_ID,
      choice({ channels: ["email"] }),
      JOB_REQUEST_ID,
    );

    expect(inserted).toHaveLength(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "notification.dispatch",
      _payload: { notificationId: "44444444-4444-4444-8444-444444444449" },
      _dedupe_key: "notification.dispatch:44444444-4444-4444-8444-444444444449",
      _requested_by: null,
    });
    expect(result.notificationIds).toEqual(["44444444-4444-4444-8444-444444444449"]);
  });

  test("a reused row that already went out is reported and not dispatched again", async () => {
    // صف مُرسَل لا يحتاج تصريفاً جديداً — إعادة الحجز للمعلّق فقط.
    priorDeliveries.mockResolvedValue({
      data: [{ id: "44444444-4444-4444-8444-444444444449", state: "sent" }],
      error: null,
    });

    const result = await sendCompanyInformation(
      TENANT_ID,
      COMPANY_ID,
      choice({ channels: ["email"] }),
      JOB_REQUEST_ID,
    );

    expect(inserted).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(result.notificationIds).toEqual(["44444444-4444-4444-8444-444444444449"]);
  });

  test("the pick policy of the report handler decides which row is reused (GR-009)", async () => {
    // صف أحدث فاشل لا يحجب صفّاً أقدم معلّقاً — نفس سياسة `pickExistingDelivery`
    // التي يعيد بها معالج التقارير.
    priorDeliveries.mockResolvedValue({
      data: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          state: "failed",
          created_at: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "44444444-4444-4444-8444-444444444449",
          state: "queued",
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      error: null,
    });

    const result = await sendCompanyInformation(
      TENANT_ID,
      COMPANY_ID,
      choice({ channels: ["email"] }),
      JOB_REQUEST_ID,
    );

    expect(result.notificationIds).toEqual(["44444444-4444-4444-8444-444444444449"]);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "notification.dispatch",
      _payload: { notificationId: "44444444-4444-4444-8444-444444444449" },
      _dedupe_key: "notification.dispatch:44444444-4444-4444-8444-444444444449",
      _requested_by: null,
    });
  });

  test("a racing insert refused by the delivery index reuses the row and queues no second copy", async () => {
    // عاملان على نفس المهمة يمرّان معاً من الفحص السريع؛ الفهرس الفريد
    // (миغرة 312) هو الضمانة: إدراج الثاني يرتكب 23505، فيعيد صف الأول — بلا
    // صف ثانٍ. الصف المعلّق يُعاد حجز تصريفه بالمفتاح نفسه (GR-003)، فالصندوق
    // يطوي الحجزين على مهمة واحدة والفايز يملك التسليم.
    notifyInsertSingle.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    priorDeliveries.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({
      data: [
        {
          id: "44444444-4444-4444-8444-444444444449",
          state: "queued",
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
      error: null,
    });

    const result = await sendCompanyInformation(
      TENANT_ID,
      COMPANY_ID,
      choice({ channels: ["email"] }),
      JOB_REQUEST_ID,
    );

    expect(result.notificationIds).toEqual(["44444444-4444-4444-8444-444444444449"]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "notification.dispatch",
      _payload: { notificationId: "44444444-4444-4444-8444-444444444449" },
      _dedupe_key: "notification.dispatch:44444444-4444-4444-8444-444444444449",
      _requested_by: null,
    });
  });

  test("a non-duplicate insert error still throws instead of hiding behind a lookup", async () => {
    // 23505 وحده هو تصادم المفتاح؛ أي خطأ آخر يجب أن يُرمى كما هو.
    notifyInsertSingle.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied" },
    });

    await expect(
      sendCompanyInformation(
        TENANT_ID,
        COMPANY_ID,
        choice({ channels: ["email"] }),
        JOB_REQUEST_ID,
      ),
    ).rejects.toThrow("permission denied");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the company.info.send handler", () => {
  test("writes the rows for the tenant in the payload and queues their delivery", async () => {
    const handler = createCompanyInfoSendHandler();

    const result = await handler({
      jobRequestId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_ID,
      payload: { tenantId: TENANT_ID, channels: ["email", "whatsapp"], language: "ar" },
      attempt: 1,
    });

    expect(inserted).toHaveLength(2);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ tenantId: TENANT_ID });
  });

  test("sends the channels and the language the payload carries", async () => {
    const handler = createCompanyInfoSendHandler();

    await handler({
      jobRequestId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY_ID,
      payload: { tenantId: TENANT_ID, channels: ["email"], language: "en" },
      attempt: 1,
    });

    expect(inserted.map((row) => row.channel)).toEqual(["email"]);
    expect(inserted[0]).toMatchObject({ locale: "en", subject: "Company information" });
  });
});
