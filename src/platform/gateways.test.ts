import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformGatewayLaunchRow } from "@/integrations/supabase/database.types";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  rows: [] as PlatformGatewayLaunchRow[],
  liveConnections: [] as Array<{ provider: string }>,
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
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
          eq: (_col: string, val: string) =>
            table === "gateway_connections"
              ? Promise.resolve({ data: mocks.liveConnections, error: null })
              : {
                  maybeSingle: async () => ({
                    data: mocks.rows.find((row) => row.provider === val) ?? null,
                    error: null,
                  }),
                },
          order: async () => ({
            data: mocks.rows,
            error: null,
          }),
        }),
        upsert: (payload: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              mocks.writes.push({ table, op: "upsert", payload });
              const row: PlatformGatewayLaunchRow = {
                provider: payload.provider as PlatformGatewayLaunchRow["provider"],
                live_allowed: Boolean(payload.live_allowed),
                checklist_note: (payload.checklist_note as string | null) ?? null,
                updated_by: (payload.updated_by as string | null) ?? null,
                updated_at: "2026-11-27T12:00:00.000Z",
              };
              return { data: row, error: null };
            },
          }),
        }),
        insert: async (payload: unknown) => {
          mocks.writes.push({ table, op: "insert", payload });
          return { error: null };
        },
      };
    },
  },
}));

import { platformListGatewayLaunch, platformSetGatewayLiveAllowed } from "./gateways";

/** يعيد صفوف التدقيق المسجّلة أثناء الاختبار. */
function auditWrites(): Array<Record<string, unknown>> {
  return mocks.writes
    .filter((write) => write.table === "platform_audit_log")
    .map((write) => write.payload as Record<string, unknown>);
}

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.rows = [
    {
      provider: "myfatoorah",
      live_allowed: false,
      checklist_note: null,
      updated_by: null,
      updated_at: "2026-11-27T10:00:00.000Z",
    },
    {
      provider: "tap",
      live_allowed: false,
      checklist_note: null,
      updated_by: null,
      updated_at: "2026-11-27T10:00:00.000Z",
    },
    {
      provider: "upayments",
      live_allowed: false,
      checklist_note: null,
      updated_by: null,
      updated_at: "2026-11-27T10:00:00.000Z",
    },
  ];
  mocks.liveConnections = [];
  mocks.writes = [];
  mocks.from.mockReset();
});

describe("platform gateway launch operations (T151)", () => {
  it("refuses non-platform-admin callers before any database read or write", async () => {
    mocks.isAdmin = false;

    await expect(platformListGatewayLaunch()).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    await expect(
      platformSetGatewayLiveAllowed({ provider: "myfatoorah", allowed: true }),
    ).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it("lists all gateway providers in canonical order", async () => {
    const result = await platformListGatewayLaunch();
    expect(result.map((row) => row.provider)).toEqual(["myfatoorah", "tap", "upayments"]);
    expect(result.every((row) => row.live_allowed === false)).toBe(true);
  });

  it("reports how many companies are already live on each provider", async () => {
    mocks.liveConnections = [
      { provider: "myfatoorah" },
      { provider: "myfatoorah" },
      { provider: "tap" },
    ];

    const result = await platformListGatewayLaunch();

    expect(result.map((row) => [row.provider, row.live_connections])).toEqual([
      ["myfatoorah", 2],
      ["tap", 1],
      ["upayments", 0],
    ]);
  });

  it("refuses an unknown gateway provider", async () => {
    const invalid = { provider: "stripe", allowed: true } as unknown as Parameters<
      typeof platformSetGatewayLiveAllowed
    >[0];

    await expect(platformSetGatewayLiveAllowed(invalid)).rejects.toThrow();
    expect(mocks.writes).toEqual([]);
  });

  it("writes nothing and logs no audit row on a no-op update", async () => {
    const result = await platformSetGatewayLiveAllowed({
      provider: "myfatoorah",
      allowed: false,
    });

    expect(result.live_allowed).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it("updates live_allowed and writes an audit row with before and after values", async () => {
    const result = await platformSetGatewayLiveAllowed({
      provider: "myfatoorah",
      allowed: true,
      checklistNote: "SC-012 sandbox verified",
    });

    expect(result.live_allowed).toBe(true);
    expect(result.checklist_note).toBe("SC-012 sandbox verified");

    const upserts = mocks.writes.filter((write) => write.table === "platform_gateway_launch");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({
      provider: "myfatoorah",
      live_allowed: true,
      checklist_note: "SC-012 sandbox verified",
      updated_by: ADMIN_ID,
    });

    expect(auditWrites()).toHaveLength(1);
    expect(auditWrites()[0]).toMatchObject({
      action: "gateway.live_allowed.update",
      entity: "gateway_launch",
      entity_id: "myfatoorah",
      actor_id: ADMIN_ID,
      before: { provider: "myfatoorah", live_allowed: false, checklist_note: null },
      after: {
        provider: "myfatoorah",
        live_allowed: true,
        checklist_note: "SC-012 sandbox verified",
      },
    });
  });
});
