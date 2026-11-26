import { beforeEach, describe, expect, it, vi } from "vitest";

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

const from = vi.fn();

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (...args: unknown[]) => from(...args),
  }),
}));

vi.mock("@/lib/emailTemplates", () => ({
  portalInvoicesUrl: () => "https://danat-future.com/portal/invoices",
}));

const {
  collectPlaceholders,
  findMissingPlaceholders,
  resolveVariablesSchema,
  buildFinalMessage,
  catalogueKeysFor,
} = await import("./resolveTemplateVariables");

describe("collectPlaceholders", () => {
  it("collects every distinct placeholder", () => {
    expect(collectPlaceholders("Dear {{tenant_name}}, {{amount}} for {{ period }}")).toEqual([
      "tenant_name",
      "amount",
      "period",
    ]);
  });

  it("tolerates the spaced form the renderer accepts", () => {
    expect(collectPlaceholders("{{ amount }}")).toEqual(["amount"]);
  });
});

describe("findMissingPlaceholders", () => {
  it("reports a placeholder with no resolved value", () => {
    expect(findMissingPlaceholders("{{a}} {{b}}", { a: "1" })).toEqual(["b"]);
  });

  it("counts an empty string as missing — a blank amount is not a resolved amount", () => {
    expect(findMissingPlaceholders("{{a}}", { a: "" })).toEqual(["a"]);
  });

  it("ignores variables inside a hidden section but reports unknowns in shown ones", () => {
    // The wrapped invoice-document body hides {{subtotal}}/{{discount}} behind
    // a {{#discount}} section; with no discount those are not "missing" — they
    // are deliberately absent — while an unresolved key inside a shown section
    // is still a typo the preview must surface.
    const body =
      "<p>{{invoice_number}}</p>{{#discount}}<p>{{subtotal}} — {{discount}}</p>{{/discount}}{{#paid}}{{foo}}{{/paid}}";
    expect(
      findMissingPlaceholders(body, { invoice_number: "INV-1", discount: "", paid: "10 KWD" }),
    ).toEqual(["foo"]);
  });
});

describe("resolveVariablesSchema", () => {
  it("rejects a non-uuid tenant", () => {
    expect(resolveVariablesSchema.safeParse({ tenantId: "nope" }).success).toBe(false);
  });

  it("accepts overrides for preview/send parity", () => {
    expect(
      resolveVariablesSchema.safeParse({
        tenantId: "11111111-1111-4111-8111-111111111111",
        templateCode: "overdue-reminder-ar",
        locale: "ar",
        variables: { outstanding: "1.000 KWD" },
        subject: null,
        body: null,
      }).success,
    ).toBe(true);
  });
});

/**
 * Builds a thenable chain that answers the last terminal call.
 */
function chainResult(result: { data: unknown; error: unknown }) {
  const terminal = Promise.resolve(result);
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const method of [
    "select",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "is",
    "not",
    "order",
    "limit",
    "contains",
  ]) {
    api[method] = vi.fn(self);
  }
  api.single = vi.fn(() => terminal);
  api.maybeSingle = vi.fn(() => terminal);
  Object.assign(api, {
    then: (terminal as Promise<unknown>).then.bind(terminal),
    catch: (terminal as Promise<unknown>).catch.bind(terminal),
  });
  return api;
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildFinalMessage catalogue", () => {
  it("resolves overdue_reminder keys from the real catalogue (outstanding, days_overdue)", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: {
            id: TENANT_ID,
            name: "أحمد",
            company_id: null,
            preferred_language: "ar",
          },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({
          data: { name_ar: "دانة", name_en: "Danat" },
          error: null,
        });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "overdue-reminder-ar",
            type: "overdue_reminder",
            locale: "ar",
            channel: "both",
            is_active: true,
            subject_ar: "متأخر ({{days_overdue}} يوم)",
            subject_en: "Overdue ({{days_overdue}} days)",
            body_ar: "رصيد {{outstanding}} منذ {{days_overdue}} يوماً",
            body_en: "Balance {{outstanding}} for {{days_overdue}} days",
          },
          error: null,
        });
      }
      if (table === "invoices") {
        return chainResult({
          data: [
            {
              id: "inv-1",
              tenant_id: TENANT_ID,
              contract_id: CONTRACT_ID,
              balance: 250,
              due_date: "2026-06-01",
              state: "overdue",
              is_visible_to_tenant: true,
            },
          ],
          error: null,
        });
      }
      if (table === "contracts") {
        return chainResult({
          data: [{ id: CONTRACT_ID }],
          error: null,
        });
      }
      return chainResult({ data: null, error: null });
    });

    const final = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "overdue-reminder-ar",
      locale: "ar",
      asOf: "2026-07-01",
    });

    expect(catalogueKeysFor("overdue_reminder")).toEqual(
      expect.arrayContaining(["tenant_name", "outstanding", "days_overdue"]),
    );
    expect(final.variables.outstanding).toBe("250 KWD");
    expect(final.variables.days_overdue).toBe("30");
    // Plan's wrong keys must NOT be inventively filled as primary catalogue values.
    expect(final.variables.amount).toBeUndefined();
    expect(final.bodyHtml).toContain("250 KWD");
    expect(final.bodyHtml).not.toContain("{{outstanding}}");
    expect(final.subject).toContain("30");
    expect(final.missing).toEqual([]);
  });

  it("surfaces unknown placeholders that the catalogue does not supply", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: {
            id: TENANT_ID,
            name: "أحمد",
            company_id: null,
            preferred_language: "ar",
          },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "overdue-reminder-ar",
            type: "overdue_reminder",
            locale: "ar",
            channel: "both",
            is_active: true,
            subject_ar: "س",
            subject_en: "S",
            // Admin body still uses the migration-07 keys the plan wrongly listed.
            body_ar: "المبلغ {{amount}} عن {{unit}}",
            body_en: "Amount {{amount}} for {{unit}}",
          },
          error: null,
        });
      }
      if (table === "invoices") {
        return chainResult({
          data: [
            {
              id: "inv-1",
              tenant_id: TENANT_ID,
              contract_id: CONTRACT_ID,
              balance: 100,
              due_date: "2026-06-01",
              state: "overdue",
              is_visible_to_tenant: true,
            },
          ],
          error: null,
        });
      }
      if (table === "contracts") {
        return chainResult({ data: [{ id: CONTRACT_ID }], error: null });
      }
      return chainResult({ data: null, error: null });
    });

    const final = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "overdue-reminder-ar",
      locale: "ar",
      asOf: "2026-07-01",
    });

    // outstanding is resolved; amount/unit are not catalogue keys for overdue → missing.
    expect(final.variables.outstanding).toBe("100 KWD");
    expect(final.missing).toEqual(expect.arrayContaining(["amount", "unit"]));
    expect(final.bodyHtml).toContain("{{amount}}");
  });

  it("escapes HTML in bodyHtml but leaves subject unescaped", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: {
            id: TENANT_ID,
            name: "A & B <script>",
            company_id: null,
            preferred_language: "en",
          },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "د", name_en: "D" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "due-reminder-en",
            type: "due_reminder",
            locale: "en",
            channel: "both",
            is_active: true,
            subject_ar: "س {{tenant_name}}",
            subject_en: "S {{tenant_name}}",
            body_ar: "<p>{{tenant_name}}</p>",
            body_en: "<p>{{tenant_name}}</p>",
          },
          error: null,
        });
      }
      if (table === "invoices") {
        return chainResult({ data: [], error: null });
      }
      return chainResult({ data: null, error: null });
    });

    const final = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "due-reminder-en",
      locale: "en",
    });

    expect(final.bodyHtml).toContain("&amp;");
    expect(final.bodyHtml).toContain("&lt;script&gt;");
    expect(final.bodyHtml).not.toContain("<script>");
    // Subject is a plain header — escaping would ship a literal &amp; to SMTP.
    expect(final.subject).toContain("A & B <script>");
    expect(final.bodyText).toContain("A & B <script>");
  });

  it("applies variable overrides on the builder path (preview == send)", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: {
            id: TENANT_ID,
            name: "أحمد",
            company_id: null,
            preferred_language: "ar",
          },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "overdue-reminder-ar",
            type: "overdue_reminder",
            locale: "ar",
            channel: "both",
            is_active: true,
            subject_ar: "{{outstanding}}",
            subject_en: "{{outstanding}}",
            body_ar: "{{outstanding}}",
            body_en: "{{outstanding}}",
          },
          error: null,
        });
      }
      if (table === "invoices") {
        return chainResult({ data: [], error: null });
      }
      return chainResult({ data: null, error: null });
    });

    const final = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "overdue-reminder-ar",
      locale: "ar",
      variables: { outstanding: "999.000 KWD" },
    });

    expect(final.subject).toBe("999.000 KWD");
    expect(final.bodyHtml).toBe("999.000 KWD");
  });

  it("a missing code still yields unavailableReason", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: { id: TENANT_ID, name: "أحمد", company_id: null, preferred_language: "ar" },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({ data: null, error: null });
      }
      return chainResult({ data: null, error: null });
    });

    const result = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "no-such-code" });
    expect(result.unavailableReason).toMatch(/no active/i);
    expect(result.templateCode).toBeNull();
  });

  it("an inactive code still yields unavailableReason", async () => {
    // Fixture must return is_active: false for this code.
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: { id: TENANT_ID, name: "أحمد", company_id: null, preferred_language: "ar" },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "inactive-code",
            type: "receipt",
            locale: "ar",
            channel: "email",
            is_active: false,
            subject_ar: "{{payment_date}}",
            subject_en: "{{payment_date}}",
            body_ar: "{{payment_date}}",
            body_en: "{{payment_date}}",
          },
          error: null,
        });
      }
      return chainResult({ data: null, error: null });
    });

    const result = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "inactive-code" });
    expect(result.unavailableReason).toMatch(/no active/i);
  });

  // Behavioural parity with MANUALLY_RENDERABLE_TYPES — replaces the source-grep
  // test an earlier draft proposed. Asserted through the PUBLIC buildFinalMessage,
  // so no production symbol is exported purely for testability and the test
  // survives any refactor of resolveTypeVariables' internals.
  it("a gate-2 type resolves its variables; a non-gate-2 type does not", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: { id: TENANT_ID, name: "أحمد", company_id: null, preferred_language: "ar" },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "receipt",
            type: "receipt",
            locale: "ar",
            channel: "email",
            is_active: true,
            subject_ar: "{{payment_date}}",
            subject_en: "{{payment_date}}",
            body_ar: "دفع في {{payment_date}}",
            body_en: "Paid on {{payment_date}}",
          },
          error: null,
        });
      }
      if (table === "payments") {
        return chainResult({
          data: [
            {
              id: "pay-1",
              amount: 100,
              currency: "KWD",
              status: "confirmed",
              payment_date: "2026-08-01",
              created_at: "2026-08-01",
              reference: "PAY-1",
              code: "PAY-1",
            },
          ],
          error: null,
        });
      }
      return chainResult({ data: null, error: null });
    });

    // receipt is in MANUALLY_RENDERABLE_TYPES: its placeholders resolve.
    const good = await buildFinalMessage({ tenantId: TENANT_ID, templateCode: "receipt" });
    expect(good.missing).not.toContain("payment_date");

    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: { id: TENANT_ID, name: "أحمد", company_id: null, preferred_language: "ar" },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "notification_templates") {
        return chainResult({
          data: {
            code: "deposit-confirmation",
            type: "deposit_confirmation",
            locale: "ar",
            channel: "email",
            is_active: true,
            subject_ar: "{{bank_name}}",
            subject_en: "{{bank_name}}",
            body_ar: "إيداع في {{bank_name}}",
            body_en: "Deposit at {{bank_name}}",
          },
          error: null,
        });
      }
      return chainResult({ data: null, error: null });
    });

    // deposit_confirmation is not: every type-specific placeholder lands in missing.
    const bad = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "deposit-confirmation",
    });
    expect(bad.missing).toContain("bank_name");
  });
});

describe("buildFinalMessage — free text", () => {
  beforeEach(() => {
    from.mockReset();
  });

  /** يثبّت الجداول التي تقرأها مُحلّلات النص الحر بقيم مميّزة لكل منها. */
  function stubFreeTextTables() {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        return chainResult({
          data: { id: TENANT_ID, name: "أحمد", company_id: null, preferred_language: "ar" },
          error: null,
        });
      }
      if (table === "companies") {
        return chainResult({ data: { name_ar: "دانة", name_en: "Danat" }, error: null });
      }
      if (table === "invoices") {
        return chainResult({
          data: [
            {
              id: "inv-1",
              tenant_id: TENANT_ID,
              contract_id: CONTRACT_ID,
              balance: 250,
              due_date: "2026-08-10",
              state: "due",
              is_visible_to_tenant: true,
            },
          ],
          error: null,
        });
      }
      if (table === "payments") {
        // Deliberately 100, not 250: identical values would let a merge bug that
        // maps both amounts to the same source pass unnoticed.
        return chainResult({
          data: [
            {
              id: "pay-1",
              amount: 100,
              currency: "KWD",
              status: "confirmed",
              payment_date: "2026-08-01",
              created_at: "2026-08-01",
              reference: "PAY-1",
              code: "PAY-1",
            },
          ],
          error: null,
        });
      }
      if (table === "contracts") {
        return chainResult({
          data: [
            {
              id: CONTRACT_ID,
              code: "CTR-1",
              end_date: "2026-12-31",
              state: "active",
              start_date: "2026-01-01",
            },
          ],
          error: null,
        });
      }
      if (table === "contract_units") {
        return chainResult({
          data: [{ contract_id: CONTRACT_ID, unit_id: "unit-1" }],
          error: null,
        });
      }
      if (table === "units") {
        return chainResult({ data: [{ id: "unit-1", code: "A-12", name: "شقة" }], error: null });
      }
      return chainResult({ data: null, error: null });
    });
  }

  it("resolves the union but leaves the ambiguous {{amount}} missing", async () => {
    // `amount` is absent from the free-text catalogue on purpose: it means the
    // invoice balance in one resolver and the payment amount in another. It must
    // stay unresolved rather than silently pick one of them.
    stubFreeTextTables();

    const final = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: null,
      locale: "ar",
      body: "{{invoice_amount}} {{payment_amount}} {{unit}} {{amount}}",
      asOf: "2026-08-12",
    });

    expect(final.variables.invoice_amount).toBe("250 KWD");
    expect(final.variables.payment_amount).toBe("100 KWD");
    expect(final.variables.unit).toContain("A-12");
    expect(final.missing).toContain("amount");
  });

  it("reads no unrelated tables for a body with no placeholders", async () => {
    // sendBulkNotification awaits this once per recipient. A plain message must
    // not drag in invoices, payments, contracts and units for every tenant.
    stubFreeTextTables();

    await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: null,
      locale: "ar",
      body: "شكراً لتعاملكم معنا",
      asOf: "2026-08-12",
    });

    const tablesRead = from.mock.calls.map(([table]) => table);
    expect(tablesRead).toEqual(["tenants", "companies"]);
  });

  it("reads only the family a placeholder needs", async () => {
    // {{outstanding}} is served by the overdue resolver alone; the receipt and
    // expiry families must stay untouched.
    stubFreeTextTables();

    await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: null,
      locale: "ar",
      body: "رصيدك {{outstanding}}",
      asOf: "2026-08-12",
    });

    const tablesRead = from.mock.calls.map(([table]) => table);
    expect(tablesRead).toContain("invoices");
    expect(tablesRead).not.toContain("payments");
    expect(tablesRead).not.toContain("units");
  });
});
