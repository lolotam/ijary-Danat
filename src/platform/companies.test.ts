import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  callerRpc: vi.fn(),
  getRequest: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: {
      admin: {
        createUser: mocks.createUser,
        updateUserById: mocks.updateUserById,
        deleteUser: mocks.deleteUser,
      },
    },
  },
}));

import { platformCreateCompany, platformListCompanies, platformUpdateCompany } from "./companies";
import { PLATFORM_ADMIN_REQUIRED } from "./requirePlatformAdmin.server";
import { SLUG_IMMUTABLE, SLUG_INVALID, SLUG_RESERVED, SLUG_TAKEN } from "./slug";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** نتيجة استعلام واحدة: ما يرد به، وكم صفاً يعود. */
interface QueryOutcome {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/** كتابة واحدة سجّلها الاستعلام الوهمي. */
interface RecordedWrite {
  table: string;
  method: string;
  payload?: unknown;
}

/**
 * يثبّت قاعدة بيانات وهمية: تحفظ كل كتابة وتردّ بما يحدده الاختبار.
 *
 * The responses are keyed by `table:method` — `companies:insert`,
 * `companies:update`, `seed_company_defaults` — because one table is read and
 * written in different shapes inside the same operation.
 */
function installFakeDatabase(responses: Record<string, QueryOutcome> = {}): {
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const outcomeFor = (key: string): QueryOutcome => responses[key] ?? { data: null, error: null };

  mocks.from.mockImplementation((table: string) => {
    let writeMethod: string | null = null;

    const chain: Record<string, unknown> = {};
    const methods = [
      "select",
      "insert",
      "upsert",
      "update",
      "delete",
      "eq",
      "neq",
      "ilike",
      "in",
      "or",
      "order",
      "range",
      "limit",
      "offset",
      "is",
      "not",
      "gte",
      "gt",
      "lt",
    ];
    for (const method of methods) {
      chain[method] = vi.fn((...args: unknown[]) => {
        if (
          method === "insert" ||
          method === "upsert" ||
          method === "update" ||
          method === "delete"
        ) {
          writeMethod = method;
          writes.push({ table, method, payload: args[0] });
        }
        return chain;
      });
    }

    const result = () => {
      const outcome = outcomeFor(`${table}:${writeMethod ?? "select"}`);
      return Promise.resolve({
        data: outcome.data ?? null,
        error: outcome.error ?? null,
        count: outcome.count ?? null,
      });
    };

    chain.single = vi.fn(result);
    chain.maybeSingle = vi.fn(result);
    chain.then = (onFulfilled: unknown, onRejected: unknown) =>
      result().then(
        onFulfilled as (value: unknown) => unknown,
        onRejected as (reason: unknown) => unknown,
      );

    return chain;
  });

  mocks.rpc.mockImplementation(async (fn: string) => {
    const outcome = outcomeFor(fn);
    return { data: outcome.data ?? null, error: outcome.error ?? null };
  });

  return { writes };
}

/** يكتب الاختبار على الجدول نفسه أكثر من مرة؛ هذا يختار واحدة بعينها. */
function writeTo(
  writes: RecordedWrite[],
  table: string,
  method: string,
): RecordedWrite | undefined {
  return writes.find((write) => write.table === table && write.method === method);
}

/** صف شركة كما تقرؤه اللوحة. */
const COMPANY_ROW = {
  id: COMPANY_ID,
  slug: "acme",
  name_ar: "أكمي",
  name_en: "Acme",
  status: "active",
  email: "hello@acme.test",
  phone: "51234567",
  whatsapp: null,
  address_ar: null,
  address_en: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("the platform company operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("PLATFORM_ROOT_HOST", "ijary.app");

    const token = `header.${Buffer.from(
      JSON.stringify({ sub: ADMIN_ID, aal: "aal2" }),
      "utf8",
    ).toString("base64url")}.signature`;

    mocks.getRequest.mockReturnValue({
      headers: {
        get: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    });
    mocks.createClient.mockReturnValue({ rpc: mocks.callerRpc });
    mocks.callerRpc.mockResolvedValue({ data: true, error: null });
    mocks.createUser.mockImplementation(async (attributes: { id: string }) => ({
      data: { user: { id: attributes.id } },
      error: null,
    }));
    mocks.updateUserById.mockResolvedValue({ data: {}, error: null });
    mocks.deleteUser.mockResolvedValue({ data: null, error: null });
  });

  describe("platformCreateCompany", () => {
    const CREATION = {
      nameAr: "أكمي",
      nameEn: "Acme",
      slug: "acme",
      firstAdmin: { fullName: "Amina", username: "amina", email: "amina@acme.test" },
    };

    it("creates the company, its subdomain row and its defaults from the platform catalogue", async () => {
      const { writes } = installFakeDatabase({
        "companies:insert": { data: { id: COMPANY_ID } },
      });

      await platformCreateCompany(CREATION);

      expect(writeTo(writes, "companies", "insert")?.payload).toMatchObject({
        name_ar: "أكمي",
        name_en: "Acme",
        slug: "acme",
      });
      expect(writeTo(writes, "company_domains", "insert")?.payload).toEqual({
        company_id: COMPANY_ID,
        host: "acme.ijary.app",
        kind: "subdomain",
        is_primary: true,
        verification_status: "verified",
      });
      expect(mocks.rpc).toHaveBeenCalledWith("seed_company_defaults", { _company_id: COMPANY_ID });
    });

    it("creates the first administrator with a password that must be changed", async () => {
      const { writes } = installFakeDatabase({
        "companies:insert": { data: { id: COMPANY_ID } },
      });

      const result = await platformCreateCompany(CREATION);

      expect(result.tempPassword).toBeTruthy();
      expect(writeTo(writes, "profiles", "upsert")?.payload).toMatchObject({
        company_id: COMPANY_ID,
        username: "amina",
        display_name: "Amina",
        email: "amina@acme.test",
        is_active: true,
        must_change_password: true,
      });
      expect(writeTo(writes, "user_roles", "insert")?.payload).toMatchObject({
        company_id: COMPANY_ID,
        role: "admin",
        granted_by: ADMIN_ID,
      });
    });

    it("writes one audit row and keeps the temporary password out of it", async () => {
      const { writes } = installFakeDatabase({
        "companies:insert": { data: { id: COMPANY_ID } },
      });

      const result = await platformCreateCompany(CREATION);

      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({
        action: "company.create",
        entity: "company",
        entity_id: COMPANY_ID,
        company_id: COMPANY_ID,
        actor_id: ADMIN_ID,
        after: { slug: "acme", host: "acme.ijary.app" },
      });
      expect(JSON.stringify(audits[0].payload)).not.toContain(result.tempPassword);
    });

    it("returns the company id, its address and the temporary password", async () => {
      installFakeDatabase({ "companies:insert": { data: { id: COMPANY_ID } } });

      await expect(platformCreateCompany(CREATION)).resolves.toMatchObject({
        companyId: COMPANY_ID,
        host: "acme.ijary.app",
      });
    });

    it("refuses a short name the database would refuse", async () => {
      installFakeDatabase();

      await expect(platformCreateCompany({ ...CREATION, slug: "Acm" })).rejects.toThrow(
        SLUG_INVALID,
      );
      expect(mocks.from).not.toHaveBeenCalled();
    });

    it("refuses a short name reserved for the platform", async () => {
      const { writes } = installFakeDatabase({
        "reserved_slugs:select": { data: { slug: "admin" } },
      });

      await expect(platformCreateCompany({ ...CREATION, slug: "admin" })).rejects.toThrow(
        SLUG_RESERVED,
      );
      expect(writeTo(writes, "companies", "insert")).toBeUndefined();
    });

    it("refuses a short name another company already uses", async () => {
      installFakeDatabase({ "companies:select": { data: { id: COMPANY_ID } } });

      await expect(platformCreateCompany(CREATION)).rejects.toThrow(SLUG_TAKEN);
    });

    it("refuses a caller that is not a platform admin", async () => {
      installFakeDatabase();
      mocks.callerRpc.mockResolvedValue({ data: false, error: null });

      await expect(platformCreateCompany(CREATION)).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
      expect(mocks.from).not.toHaveBeenCalled();
    });

    it("suspends the company and says so when GoTrue refuses the administrator", async () => {
      const { writes } = installFakeDatabase({
        "companies:insert": { data: { id: COMPANY_ID } },
      });
      mocks.createUser.mockResolvedValue({
        data: { user: null },
        error: { message: "email address invalid" },
      });

      await expect(platformCreateCompany(CREATION)).rejects.toThrow(
        /company creation failed: auth user creation failed: email address invalid/,
      );

      expect(writeTo(writes, "companies", "update")?.payload).toMatchObject({
        status: "suspended",
        suspended_reason: "creation failed",
        suspended_by: ADMIN_ID,
      });
      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({ action: "company.create_failed" });
    });

    it("deletes the administrator account and suspends the company when the profile fails", async () => {
      const { writes } = installFakeDatabase({
        "companies:insert": { data: { id: COMPANY_ID } },
        "profiles:upsert": { error: { message: "permission denied" } },
      });

      await expect(platformCreateCompany(CREATION)).rejects.toThrow(
        /company creation failed: profile insert failed: permission denied/,
      );

      expect(mocks.deleteUser).toHaveBeenCalledTimes(1);
      expect(writeTo(writes, "companies", "update")?.payload).toMatchObject({
        status: "suspended",
        suspended_reason: "creation failed",
      });
    });
  });

  describe("platformListCompanies", () => {
    it("returns the companies with the number of accounts each one holds", async () => {
      installFakeDatabase({
        "companies:select": { data: [COMPANY_ROW], count: 1 },
        "profiles:select": { data: [{ company_id: COMPANY_ID }, { company_id: COMPANY_ID }] },
      });

      const result = await platformListCompanies({});

      expect(result.count).toBe(1);
      expect(result.rows[0]).toMatchObject({
        id: COMPANY_ID,
        slug: "acme",
        nameEn: "Acme",
        status: "active",
        userCount: 2,
      });
    });

    it("refuses a caller that is not a platform admin", async () => {
      installFakeDatabase();
      mocks.callerRpc.mockResolvedValue({ data: false, error: null });

      await expect(platformListCompanies({})).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
    });
  });

  describe("platformUpdateCompany", () => {
    it("writes the new names and contact details", async () => {
      const { writes } = installFakeDatabase({
        "companies:select": { data: COMPANY_ROW },
        "companies:update": { data: { ...COMPANY_ROW, name_en: "Acme Holding" } },
      });

      const result = await platformUpdateCompany({
        companyId: COMPANY_ID,
        nameEn: "Acme Holding",
        phone: "51234567",
      });

      expect(result.nameEn).toBe("Acme Holding");
      expect(writeTo(writes, "companies", "update")?.payload).toEqual({
        name_en: "Acme Holding",
        phone: "51234567",
      });
    });

    it("writes one audit row carrying the state before and after", async () => {
      const { writes } = installFakeDatabase({
        "companies:select": { data: COMPANY_ROW },
        "companies:update": { data: { ...COMPANY_ROW, name_en: "Acme Holding" } },
      });

      await platformUpdateCompany({ companyId: COMPANY_ID, nameEn: "Acme Holding" });

      const audits = writes.filter((write) => write.table === "platform_audit_log");
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({
        action: "company.update",
        entity: "company",
        entity_id: COMPANY_ID,
        company_id: COMPANY_ID,
        actor_id: ADMIN_ID,
        before: { name_en: "Acme" },
        after: { name_en: "Acme Holding" },
      });
    });

    it("refuses a short name change, which the database freezes after the insert", async () => {
      installFakeDatabase({ "companies:select": { data: COMPANY_ROW } });

      await expect(
        platformUpdateCompany({ companyId: COMPANY_ID, slug: "another-name" }),
      ).rejects.toThrow(SLUG_IMMUTABLE);
    });
  });
});
