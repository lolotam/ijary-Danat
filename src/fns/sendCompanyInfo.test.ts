import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = (input?: { data?: unknown }) =>
      fn._handler({ data: input?.data, context: fn._context });
    fn._context = {
      supabase: { rpc: async () => ({ data: true, error: null }) },
      userId: "admin-user",
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockImplementation(() => fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const dispatch = vi.fn();
vi.mock("@/fns/dispatchNotification", () => ({
  dispatchNotificationRecord: (id: string) => dispatch(id),
}));

const TEST_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TEST_COMPANY = {
  id: TEST_COMPANY_ID,
  slug: "danat",
  status: "active" as const,
  host: "danat.localhost",
};

const inserted: Array<Record<string, unknown>> = [];
const uploads: string[] = [];

const clientStub = {
  from: (table: string) => {
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "tenant-1",
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
                id: TEST_COMPANY_ID,
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
      // No admin-edited copy: the sender falls back to its built-in wording.
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        }),
      };
    }
    if (table === "notifications") {
      return {
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { ...row, id: `n-${inserted.length}` }, error: null }),
            }),
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
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => clientStub,
}));

const { sendCompanyInfo } = await import("./sendCompanyInfo");

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  uploads.length = 0;
  dispatch.mockResolvedValue({ state: "sent" });
});

describe("sendCompanyInfo", () => {
  test("the WhatsApp row carries the same PDF as the email row", async () => {
    // Evolution sends `attachment_paths` as document parts, so withholding the
    // key from the WhatsApp leg meant the tenant got the summary but never the
    // bank-details document the button promises.
    await sendCompanyInfo({ data: { tenantId: "tenant-1", channels: ["email", "whatsapp"] } });

    expect(uploads).toHaveLength(1);
    const [pdfPath] = uploads;
    expect(pdfPath).toMatch(
      new RegExp(`^companies/${TEST_COMPANY_ID}/company-info/tenant-1_\\d+\\.pdf$`),
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
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  test("the WhatsApp body is plain text addressed to the tenant's number", async () => {
    await sendCompanyInfo({ data: { tenantId: "tenant-1", channels: ["whatsapp"] } });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      channel: "whatsapp",
      recipient_address: "+96550000000",
      subject: null,
    });
    expect(String(inserted[0].body)).not.toContain("<");
  });
});
