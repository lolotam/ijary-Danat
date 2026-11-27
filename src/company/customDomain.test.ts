/**
 * @vitest-environment jsdom
 *
 * يثبت أن المضيف المخصّص المتحقّق منه يصل إلى شركته وحدها، وأن محتوى صفحة
 * الهبوط يُقرأ لشركة المضيف وحدها.
 *
 * The Supabase clients are the only boundary replaced: the host resolver and
 * the landing hooks are the code under test. A custom host that is still
 * pending or has failed must reveal nothing, so the request answers 404 with
 * no company in it.
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOST_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

/** الجداول التي تخدمها نسخة Supabase الوهمية. */
const mocks = vi.hoisted(() => ({
  companyDomains: [] as Array<Record<string, unknown>>,
  companies: [] as Array<Record<string, unknown>>,
  landingSettings: [] as Array<Record<string, unknown>>,
  landingQueries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  getLandingCompanyId: vi.fn(),
}));

/**
 * يبني مُم chains تحاكي استعلامات Supabase وتصفّح صفوف جدول في الذاكرة.
 */
function createQueryBuilder(
  table: string,
  rows: () => Array<Record<string, unknown>>,
  record?: (entry: { table: string; filters: Record<string, unknown> }) => void,
) {
  const filters: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};

  const matching = () =>
    rows().filter((row) =>
      Object.entries(filters).every(([column, value]) => row[column] === value),
    );

  const recordQuery = () => record?.({ table, filters: { ...filters } });

  builder.select = () => builder;
  builder.eq = (column: string, value: unknown) => {
    filters[column] = value;
    return builder;
  };
  builder.order = () => builder;
  builder.maybeSingle = async () => {
    recordQuery();
    return { data: matching()[0] ?? null, error: null };
  };
  builder.single = async () => {
    recordQuery();
    return { data: matching()[0] ?? null, error: null };
  };
  builder.then = (resolve: (value: unknown) => unknown) => {
    recordQuery();
    resolve({ data: matching(), error: null }) as unknown as void;
  };
  return builder;
}

vi.mock("@tanstack/react-start", () => {
  type Handler = (context: { data: unknown; context: unknown }) => unknown;
  const fn = vi.fn() as unknown as Handler & {
    _handler: Handler;
    _context: unknown;
    middleware: (next: unknown) => unknown;
    validator: (next: (data: unknown) => unknown) => unknown;
    handler: (next: Handler) => void;
  };
  fn._handler = () => undefined;
  fn._context = undefined;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((next: Handler) => {
    fn._handler = next;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: unknown) => middlewareFn),
    }),
  };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "company_domains") {
        return createQueryBuilder(table, () => mocks.companyDomains);
      }
      if (table === "companies") {
        return createQueryBuilder(table, () => mocks.companies);
      }
      throw new Error(`Unexpected table ${table}`);
    },
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) =>
      createQueryBuilder(
        table,
        () => mocks.landingSettings,
        (entry) => mocks.landingQueries.push(entry),
      ),
  },
}));

vi.mock("@/company/rootPageDecision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/company/rootPageDecision")>()),
  getLandingCompanyId: mocks.getLandingCompanyId,
}));

import { clearHostCompanyCache, resolveHostCompany } from "@/company/hostCompany.server";
import { useLandingSettings } from "@/hooks/useLandingSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * يضبط مضيف المنصة ولوحة المشرف العام كما هي في النشر.
 */
function platformHosts(): void {
  vi.stubEnv("PLATFORM_ROOT_HOST", "ijary.app");
  vi.stubEnv("PLATFORM_ADMIN_HOST", "admin.ijary.app");
}

/**
 * صف نطاق مخصّص بحالة تحقق معيّنة.
 */
function domainRow(host: string, verificationStatus: string) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    company_id: HOST_COMPANY_ID,
    host,
    kind: "custom",
    verification_status: verificationStatus,
  };
}

let container: HTMLDivElement;
let root: Root;

/**
 * يركّب خطّاف صفحة الهبوط داخل مخزن استعلامات حقيقي.
 */
function mountLandingHook(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  function Harness() {
    const { data } = useLandingSettings("ar");
    return createElement("span", null, data?.hero_title ?? "none");
  }

  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)),
    ),
  );
}

/**
 * ينتظر وصول نتيجة الاستعلام.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearHostCompanyCache();
  platformHosts();
  mocks.companyDomains = [];
  mocks.companies = [{ id: HOST_COMPANY_ID, slug: "acme", status: "active" }];
  mocks.landingSettings = [];
  mocks.landingQueries = [];
  mocks.getLandingCompanyId.mockResolvedValue(HOST_COMPANY_ID);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  document.body.replaceChildren();
  vi.unstubAllEnvs();
});

describe("a custom domain resolves to its company only once it is verified (T189)", () => {
  it("resolves a verified custom host to the company that owns it", async () => {
    mocks.companyDomains = [domainRow("www.acme.com", "verified")];

    const resolution = await resolveHostCompany("www.acme.com");

    expect(resolution).toEqual({
      kind: "company",
      host: "www.acme.com",
      company: {
        id: HOST_COMPANY_ID,
        slug: "acme",
        status: "active",
        host: "www.acme.com",
      },
    });
  });

  it.each(["pending", "failed"])(
    "reveals no company for a %s custom host",
    async (verificationStatus) => {
      mocks.companyDomains = [domainRow("www.acme.com", verificationStatus)];

      const resolution = await resolveHostCompany("www.acme.com");

      expect(resolution).toEqual({ kind: "unknown", host: "www.acme.com", company: null });
    },
  );

  it("keeps the automatic address working beside the custom one", async () => {
    mocks.companyDomains = [domainRow("www.acme.com", "verified")];

    const resolution = await resolveHostCompany("acme.ijary.app");

    expect(resolution.kind).toBe("company");
    expect(resolution.company?.id).toBe(HOST_COMPANY_ID);
  });
});

describe("the landing content is read for the host's company only (T189)", () => {
  it("reads the landing settings of the host's company and no other company's", async () => {
    mocks.landingSettings = [
      { id: "1", company_id: HOST_COMPANY_ID, locale: "ar", hero_title: "أكمي" },
      { id: "2", company_id: OTHER_COMPANY_ID, locale: "ar", hero_title: "شركة أخرى" },
    ];

    mountLandingHook();
    await settle();

    expect(mocks.landingQueries).toHaveLength(1);
    expect(mocks.landingQueries[0].table).toBe("landing_page_settings");
    expect(mocks.landingQueries[0].filters).toMatchObject({
      company_id: HOST_COMPANY_ID,
      locale: "ar",
    });
    expect(container.textContent).toBe("أكمي");
    expect(container.textContent).not.toContain("شركة أخرى");
  });
});
