import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({ from: mocks.from }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

import { syncTenantContact } from "./syncTenantContact";

const TENANT_ID = "33333333-3333-3333-3333-333333333333";

interface StoredTenant {
  id: string;
  email: string | null;
  whatsapp: string | null;
}

interface TenantsStub {
  /** كل حمولة مرّت على tenants.update، بالترتيب. */
  updates: Array<Record<string, unknown>>;
  /** النسخة الوهمية لجدول tenants — لاثبات عدم إصدار أي تحديث. */
  table: { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
}

/**
 * يبني النسخة الوهمية لجدول tenants بسلسلتي القراءة والكتابة الكاملتين.
 *
 * Only the Supabase client boundary is mocked: the read chain resolves the
 * stored row (or the read error / a missing row), and the write chain records
 * every payload so the tests can assert exactly which columns were written.
 * Driving the outcomes through the client is what keeps these tests honest —
 * a stub of syncTenantContact itself would pass with the function deleted.
 */
function stubTenants(options: {
  stored?: StoredTenant | null;
  readError?: string;
  writeError?: string;
  writeMissingRow?: boolean;
}): TenantsStub {
  const updates: Array<Record<string, unknown>> = [];
  const table = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => {
          if (options.readError) return { data: null, error: { message: options.readError } };
          return { data: options.stored ?? null, error: null };
        }),
      })),
    })),
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return {
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (options.writeError) return { data: null, error: { message: options.writeError } };
              if (options.writeMissingRow) return { data: null, error: null };
              return { data: { id: TENANT_ID }, error: null };
            }),
          })),
        })),
      };
    }),
  };
  mocks.from.mockImplementation((name: string) => {
    if (name === "tenants") return table;
    throw new Error(`unexpected table ${name}`);
  });
  return { updates, table };
}

beforeEach(() => {
  mocks.from.mockReset();
});

describe("syncTenantContact skips no-op saves", () => {
  it("issues no update and reports synced for empty / whitespace-only contact", async () => {
    const { table } = stubTenants({
      stored: { id: TENANT_ID, email: "owner@example.com", whatsapp: "96511112222" },
    });

    await expect(syncTenantContact(TENANT_ID, { email: "", phone: "   " })).resolves.toEqual({
      synced: true,
    });
    expect(table.update).not.toHaveBeenCalled();
  });

  it("issues no update when the email differs only by case or whitespace", async () => {
    const { updates, table } = stubTenants({
      stored: { id: TENANT_ID, email: "Tenant@Example.com", whatsapp: "96511112222" },
    });

    await expect(
      syncTenantContact(TENANT_ID, {
        email: "  tenant@example.com  ",
        phone: "96511112222",
      }),
    ).resolves.toEqual({ synced: true });

    expect(table.update).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe("syncTenantContact writes only what changed", () => {
  it("writes only the lower-cased email when just the email changed", async () => {
    const { updates } = stubTenants({
      stored: { id: TENANT_ID, email: "old@example.com", whatsapp: "96511112222" },
    });

    await expect(
      syncTenantContact(TENANT_ID, { email: "New@Example.com", phone: "96511112222" }),
    ).resolves.toEqual({ synced: true });

    // Exactly one column: a phone that already matches must not be rewritten.
    expect(updates).toEqual([{ email: "new@example.com" }]);
  });

  it("writes only whatsapp when just the phone changed", async () => {
    const { updates } = stubTenants({
      stored: { id: TENANT_ID, email: "same@example.com", whatsapp: "96511112222" },
    });

    await expect(
      syncTenantContact(TENANT_ID, { email: "same@example.com", phone: "96533334444" }),
    ).resolves.toEqual({ synced: true });

    expect(updates).toEqual([{ whatsapp: "96533334444" }]);
  });
});

describe("syncTenantContact never throws", () => {
  it("reports a read error instead of throwing", async () => {
    stubTenants({ stored: null, readError: "tenants read refused" });

    await expect(syncTenantContact(TENANT_ID, { email: "a@example.com" })).resolves.toEqual({
      synced: false,
      error: "tenants read refused",
    });
  });

  it("reports a missing tenant row instead of throwing", async () => {
    const { table } = stubTenants({ stored: null });

    await expect(syncTenantContact(TENANT_ID, { email: "a@example.com" })).resolves.toEqual({
      synced: false,
      error: expect.any(String),
    });
    // Nothing to write to: the failure must come before any update.
    expect(table.update).not.toHaveBeenCalled();
  });

  it("reports an update error instead of throwing", async () => {
    stubTenants({
      stored: { id: TENANT_ID, email: null, whatsapp: null },
      writeError: "tenants update refused",
    });

    await expect(syncTenantContact(TENANT_ID, { email: "a@example.com" })).resolves.toEqual({
      synced: false,
      error: "tenants update refused",
    });
  });

  it("reports an update that matched no row instead of throwing", async () => {
    // The tenant vanished between the read and the write (debate finding 6):
    // the update succeeds with no error but returns no row.
    stubTenants({
      stored: { id: TENANT_ID, email: null, whatsapp: null },
      writeMissingRow: true,
    });

    await expect(syncTenantContact(TENANT_ID, { email: "a@example.com" })).resolves.toEqual({
      synced: false,
      error: expect.any(String),
    });
  });
});
