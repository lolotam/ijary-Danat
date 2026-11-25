import { beforeEach, describe, expect, test, vi } from "vitest";

import { contractBuilderDefaults, type ContractBuilderValues } from "@/lib/contractBuilder/schema";
import {
  FIXTURE_COMPANY,
  validCompanyContractValues,
  validContractValues,
} from "@/lib/contractBuilder/schema.fixture";

vi.mock("@tanstack/react-start", () => {
  const fn: {
    (data: unknown): unknown;
    _context?: unknown;
    _handler?: (args: { data: unknown; context: unknown }) => unknown;
    middleware: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn>;
  } = ((data: unknown) => fn._handler?.({ data, context: fn._context })) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((handler) => {
    fn._handler = handler;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

const renderHtmlToPdf = vi.fn();

vi.mock("@/lib/serverPdf", async () => {
  const actual = await vi.importActual<typeof import("@/lib/serverPdf")>("@/lib/serverPdf");
  return {
    wrapHtmlForPdf: actual.wrapHtmlForPdf,
    renderHtmlToPdf: (html: string) => renderHtmlToPdf(html),
  };
});

const { contractPdfFilename, renderContractPdf, renderContractPdfInput } =
  await import("./renderContractPdf");

const pdfBytes = Buffer.from("%PDF-1.4-contract");

/** يحقن سياق المصادقة في محاكاة الخادم دون توسيع واجهة الاستدعاء المخصصة للمتصفح. */
function bindPdfContext(context: ReturnType<typeof authContext>) {
  const serverFn = renderContractPdf as unknown as {
    _context: ReturnType<typeof authContext>;
    (data: { values: ContractBuilderValues; locale: "ar" | "en" }): Promise<Response>;
  };
  serverFn._context = context;
  return serverFn;
}

/**
 * يبني سياق مصادقة وهمي مع نتيجة has_permission.
 */
function authContext(allowed: boolean) {
  return {
    userId: "user-1",
    supabase: {
      rpc: async () => ({ data: allowed, error: null }),
    },
  };
}

beforeEach(() => {
  renderHtmlToPdf.mockReset();
  renderHtmlToPdf.mockResolvedValue(pdfBytes);
});

describe("renderContractPdfInput", () => {
  test("rejects the draft defaults and accepts the valid fixture", () => {
    expect(
      renderContractPdfInput.safeParse({
        values: contractBuilderDefaults,
        locale: "ar",
      }).success,
    ).toBe(false);
    expect(
      renderContractPdfInput.safeParse({
        values: validContractValues(),
        locale: "ar",
      }).success,
    ).toBe(true);
  });

  test("the server applies the same mode and contact rules as the form", () => {
    const parse = (values: ContractBuilderValues) =>
      renderContractPdfInput.safeParse({ values, locale: "ar" }).success;
    expect(parse(validCompanyContractValues())).toBe(true);
    expect(parse(validCompanyContractValues({ company: contractBuilderDefaults.company }))).toBe(
      false,
    );
    expect(parse(validContractValues({ contact_mobile: "" }))).toBe(false);
  });
});

describe("contractPdfFilename", () => {
  test("uses the trade name and strips unsafe characters", () => {
    expect(
      contractPdfFilename(
        validContractValues({ trade_name: "Shop / Name?", contract_date: "2025-07-01" }),
      ),
    ).toBe("contract-Shop_Name-2025-07-01.pdf");
  });

  test("falls back to the first person's full name", () => {
    expect(
      contractPdfFilename(
        validContractValues({
          trade_name: "   ",
          persons: [
            {
              full_name: "John Smith",
              nationality: "British",
              civil_id: "1",
              residence_address: "Kuwait",
            },
          ],
          contract_date: "2025-07-01",
        }),
      ),
    ).toBe("contract-John_Smith-2025-07-01.pdf");
  });

  test("a company contract falls back to the company name, not a leftover person", () => {
    expect(
      contractPdfFilename(
        validCompanyContractValues({
          trade_name: "",
          persons: [
            { full_name: "Leftover", nationality: "", civil_id: "", residence_address: "" },
          ],
          company: { ...FIXTURE_COMPANY, company_name: "Ajmal Trading" },
          contract_date: "2025-07-01",
        }),
      ),
    ).toBe("contract-Ajmal_Trading-2025-07-01.pdf");
  });
});

describe("renderContractPdf", () => {
  // An `Error`, never a `Response`: TanStack Start resolves a thrown Response
  // client-side (x-tss-raw), so the old `{ status: 403 }` refusal reached the
  // caller as a SUCCESS value and the contract screen would have tried to open
  // it as a PDF (audit M3/H2).
  test("rejects with an Error, not a Response, when permission is refused", async () => {
    const result = bindPdfContext(authContext(false))({
      values: validContractValues(),
      locale: "ar",
    });
    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.not.toBeInstanceOf(Response);
    await expect(result).rejects.toThrow("You do not have permission to read contracts.");
  });

  test("renders an Arabic PDF with the logo data URI and the computed filename", async () => {
    const values = validContractValues();
    const res = await bindPdfContext(authContext(true))({ values, locale: "ar" });

    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
    const html = renderHtmlToPdf.mock.calls[0]![0] as string;
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("data:image/png;base64,");

    const filename = contractPdfFilename(values);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(pdfBytes));
  });
});
