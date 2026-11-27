import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  currentRows: [] as Array<{ module_key: string; enabled: boolean }>,
  writes: [] as Array<{ table: string; payload: unknown }>,
  from: vi.fn(),
}));

vi.mock("./requirePlatformAdmin.server", () => ({
  requirePlatformAdmin: async () => {
    if (!mocks.isAdmin) throw new Error("PLATFORM_ADMIN_REQUIRED");
    return { userId: ADMIN_ID };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      mocks.from(table);
      return {
        select: () => ({
          eq: () => ({
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: mocks.currentRows, error: null }).then(resolve),
          }),
        }),
        upsert: async (payload: unknown) => {
          mocks.writes.push({ table, payload });
          return { error: null };
        },
        insert: async (row: unknown) => {
          mocks.writes.push({ table, payload: row });
          return { error: null };
        },
      };
    },
  },
}));

import { platformSetModules } from "./modules";

/** يضبط ما يقرره حارس المنصة للمستدعي في هذا الاختبار. */
function asCaller(admin: boolean): void {
  mocks.isAdmin = admin;
}

/** صفوف التدقيق التي كُتبت أثناء العملية. */
function auditWrites(): Array<Record<string, unknown>> {
  return mocks.writes
    .filter((write) => write.table === "platform_audit_log")
    .map((write) => write.payload as Record<string, unknown>);
}

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.currentRows = [];
  mocks.writes = [];
  mocks.from.mockReset();
});

describe("platformSetModules (T109)", () => {
  it("refuses a caller without the platform admin claim before reading or writing", async () => {
    asCaller(false);

    await expect(
      platformSetModules({
        companyId: COMPANY_ID,
        modules: [{ key: "invoices", enabled: false }],
      }),
    ).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it("refuses an unknown module key", async () => {
    const unknownInput = {
      companyId: COMPANY_ID,
      modules: [{ key: "bogus", enabled: false }],
    } as unknown as Parameters<typeof platformSetModules>[0];

    await expect(platformSetModules(unknownInput)).rejects.toThrow();
    expect(mocks.writes).toEqual([]);
  });

  it("writes nothing when every requested switch already has that value", async () => {
    mocks.currentRows = [
      { module_key: "invoices", enabled: false },
      { module_key: "landing_page", enabled: true },
    ];

    const result = await platformSetModules({
      companyId: COMPANY_ID,
      modules: [
        { key: "invoices", enabled: false },
        { key: "landing_page", enabled: true },
      ],
    });

    expect(result.invoices).toBe(false);
    expect(result.landing_page).toBe(true);
    expect(mocks.writes).toEqual([]);
  });

  it("upserts only changed rows and audits the map before and after", async () => {
    mocks.currentRows = [{ module_key: "invoices", enabled: true }];

    const result = await platformSetModules({
      companyId: COMPANY_ID,
      modules: [{ key: "invoices", enabled: false }],
    });

    const upserts = mocks.writes.filter((write) => write.table === "company_modules");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject([
      {
        company_id: COMPANY_ID,
        module_key: "invoices",
        enabled: false,
        updated_by: ADMIN_ID,
      },
    ]);
    expect(auditWrites()).toHaveLength(1);
    expect(auditWrites()[0]).toMatchObject({
      action: "company.modules.update",
      entity: "company",
      entity_id: COMPANY_ID,
      company_id: COMPANY_ID,
      actor_id: ADMIN_ID,
      before: { invoices: true },
      after: { invoices: false },
    });
    expect(result.invoices).toBe(false);
  });
});
