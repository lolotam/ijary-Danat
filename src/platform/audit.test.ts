import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { writePlatformAudit } from "./audit";

/** أسماء الحقول التي تُعدّ أسراراً مهما اختلف إملاؤها. */
const SECRET_KEYS = ["secret", "client_secret", "api_key", "API_TOKEN", "Password", "private_key"];

describe("writePlatformAudit", () => {
  let insertedRow: Record<string, unknown> | null = null;

  beforeEach(() => {
    insertedRow = null;
    mocks.from.mockReset();
    mocks.insert.mockReset();
    mocks.from.mockReturnValue({ insert: mocks.insert });
    mocks.insert.mockImplementation(async (row: Record<string, unknown>) => {
      insertedRow = row;
      return { data: null, error: null };
    });
  });

  it("writes the action and drops the secret fields from the payload", async () => {
    await writePlatformAudit({
      action: "company.create",
      entity: "company",
      entityId: "company-id",
      actorId: "admin-id",
      companyId: "company-id",
      before: { name: "Acme", password: "hunter2", credentials: { api_key: "live-key" } },
      after: { name: "Acme", status: "active" },
    });

    expect(insertedRow).toEqual({
      action: "company.create",
      entity: "company",
      entity_id: "company-id",
      actor_id: "admin-id",
      company_id: "company-id",
      before: { name: "Acme", credentials: {} },
      after: { name: "Acme", status: "active" },
      ip: null,
      request_id: null,
    });
  });

  it.each(SECRET_KEYS)("drops the %s field whatever its spelling", async (secretKey) => {
    await writePlatformAudit({
      action: "gateway.save",
      entity: "gateway",
      after: { [secretKey]: "secret-value", mode: "live" },
    });

    expect(insertedRow).toMatchObject({ after: { mode: "live" } });
    expect((insertedRow?.after as Record<string, unknown>)[secretKey]).toBeUndefined();
  });

  it("raises when the audit row cannot be written", async () => {
    mocks.insert.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    await expect(
      writePlatformAudit({ action: "company.create", entity: "company" }),
    ).rejects.toThrow("Platform audit write failed: permission denied");
  });
});
