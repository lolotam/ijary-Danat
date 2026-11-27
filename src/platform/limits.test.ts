import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

type LimitsRow = {
  company_id: string;
  max_units: number | null;
  max_staff_users: number | null;
  max_whatsapp_per_month: number | null;
  max_storage_bytes: number | null;
  updated_by: string | null;
  updated_at: string;
};

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  row: null as LimitsRow | null,
  readError: null as { message: string } | null,
  writeError: null as { message: string } | null,
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
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: mocks.row, error: mocks.readError }),
        upsert: async (payload: unknown) => {
          if (mocks.writeError) return { error: mocks.writeError };
          mocks.writes.push({ table, payload });
          return { error: null };
        },
        insert: async (payload: unknown) => {
          if (mocks.writeError) return { error: mocks.writeError };
          mocks.writes.push({ table, payload });
          return { error: null };
        },
      };
      return builder;
    },
  },
}));

import { platformGetLimits, platformSetLimits } from "./limits";

/** حدود شركة كاملة؛ الصفر حد صالح وليس قيمة غير محدودة. */
const LIMITS = {
  companyId: COMPANY_ID,
  maxUnits: 12,
  maxStaffUsers: 5,
  maxWhatsappPerMonth: 100,
  maxStorageBytes: 1_000_000,
};

/** صف قاعدة البيانات المقابل لهذه الحدود. */
function rowForLimits(): LimitsRow {
  return {
    company_id: COMPANY_ID,
    max_units: 12,
    max_staff_users: 5,
    max_whatsapp_per_month: 100,
    max_storage_bytes: 1_000_000,
    updated_by: null,
    updated_at: "2026-11-01T08:00:00.000Z",
  };
}

/** سطر التدقيق الذي كُتب أثناء العملية. */
function auditWrites(): Array<Record<string, unknown>> {
  return mocks.writes
    .filter((write) => write.table === "platform_audit_log")
    .map((write) => write.payload as Record<string, unknown>);
}

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.row = null;
  mocks.readError = null;
  mocks.writeError = null;
  mocks.writes = [];
  mocks.from.mockReset();
});

describe("platform limits (T128)", () => {
  it.each([
    ["reading", () => platformGetLimits(COMPANY_ID)],
    ["writing", () => platformSetLimits({ ...LIMITS })],
  ])(
    "refuses %s by a caller without the platform admin claim before any database call",
    async (_label, call) => {
      mocks.isAdmin = false;

      await expect(call()).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.writes).toEqual([]);
    },
  );

  it("returns unlimited values for a company with no limits row", async () => {
    expect(await platformGetLimits(COMPANY_ID)).toEqual({
      companyId: COMPANY_ID,
      maxUnits: null,
      maxStaffUsers: null,
      maxWhatsappPerMonth: null,
      maxStorageBytes: null,
    });
  });

  it.each(["maxUnits", "maxStaffUsers", "maxWhatsappPerMonth", "maxStorageBytes"] as const)(
    "rejects a negative %s before writing",
    async (field) => {
      await expect(platformSetLimits({ ...LIMITS, [field]: -1 })).rejects.toThrow();
      expect(mocks.writes).toEqual([]);
    },
  );

  it("rejects a fractional limit before writing", async () => {
    await expect(platformSetLimits({ ...LIMITS, maxUnits: 1.5 })).rejects.toThrow();
    expect(mocks.writes).toEqual([]);
  });

  it("writes and audits nothing when every limit already has the requested value", async () => {
    mocks.row = rowForLimits();

    const result = await platformSetLimits({ ...LIMITS });

    expect(result).toMatchObject(LIMITS);
    expect(mocks.writes).toEqual([]);
  });

  it("upserts only changed limits and audits them before and after", async () => {
    mocks.row = {
      ...rowForLimits(),
      max_units: 4,
      max_storage_bytes: null,
    };

    const result = await platformSetLimits({ ...LIMITS });

    const upserts = mocks.writes.filter((write) => write.table === "company_limits");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({
      company_id: COMPANY_ID,
      max_units: 12,
      max_staff_users: 5,
      max_whatsapp_per_month: 100,
      max_storage_bytes: 1_000_000,
      updated_by: ADMIN_ID,
    });
    expect(auditWrites()).toHaveLength(1);
    expect(auditWrites()[0]).toMatchObject({
      action: "company.limits.update",
      entity: "company",
      entity_id: COMPANY_ID,
      company_id: COMPANY_ID,
      actor_id: ADMIN_ID,
      before: { maxUnits: 4, maxStorageBytes: null },
      after: LIMITS,
    });
    expect(result).toMatchObject(LIMITS);
  });

  it("lets the super admin set a limit to zero without treating it as unlimited", async () => {
    mocks.row = rowForLimits();

    const result = await platformSetLimits({ ...LIMITS, maxUnits: 0 });

    expect(result.maxUnits).toBe(0);
    expect(auditWrites()[0]).toMatchObject({ after: { maxUnits: 0 } });
  });

  it("propagates a failed read without writing", async () => {
    mocks.readError = { message: "permission denied" };

    await expect(platformGetLimits(COMPANY_ID)).rejects.toThrow(
      "company_limits lookup failed: permission denied",
    );
    expect(mocks.writes).toEqual([]);
  });

  it("propagates a failed upsert without auditing a change that did not happen", async () => {
    mocks.writeError = { message: "check constraint" };

    await expect(platformSetLimits({ ...LIMITS })).rejects.toThrow(
      "company_limits upsert failed: check constraint",
    );
    expect(auditWrites()).toEqual([]);
  });
});
