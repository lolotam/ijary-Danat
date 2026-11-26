import { beforeEach, describe, expect, test, vi } from "vitest";

const maybeSingle = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

// Routed by table rather than a fixed chain: the unpaused paths reach
// loadTemplateCopy, which chains two .eq() calls, and a single-.eq stub only
// survived here because every earlier test paused the workflow first and
// returned before any template was read.
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
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        in: self,
        order: self,
        limit: self,
        // Only the registry read is asserted on. Any other table (templates,
        // tenants) resolves empty so the sender falls back to its built-in copy.
        maybeSingle: () => (table === "cron_jobs" ? maybeSingle() : { data: null, error: null }),
        single: () => ({ data: null, error: null }),
      });
      return chain;
    },
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: async (targets: string[]) =>
    targets.includes("admin") || targets.includes("company") ? ["admin@example.test"] : [],
}));

const { notifyUserCredentials } = await import("./notifyUserCredentials");

const BASE = {
  username: "sara",
  password: "s3cret",
  displayName: "Sara",
  email: "sara@example.test",
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  maybeSingle.mockResolvedValue({ data: { is_active: false }, error: null });
  // Senders read `.id` off every enqueued row. Previously unset because each
  // test paused the workflow before an enqueue could happen.
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the credentials workflow switches", () => {
  test("a paused managerial workflow enqueues nothing", async () => {
    const result = await notifyUserCredentials({ ...BASE, kind: "managerial" });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, ids: [] });
  });

  test("a paused tenant workflow enqueues nothing", async () => {
    const result = await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, ids: [] });
  });

  test("the managerial path consults the managerial row", async () => {
    // The two kinds must be independently switchable. Reading one key for both
    // would make the managerial switch silently control tenant credentials too.
    await notifyUserCredentials({ ...BASE, kind: "managerial" });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "user-credentials-managerial" }),
    );
  });

  test("the tenant path consults the tenant row", async () => {
    await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "user-credentials-tenant" }),
    );
  });

  test("a managerial user gets their credentials even with only admin/company targeted", async () => {
    // Credential mail to the account owner is account provisioning, not a
    // notification preference. No recipient_targets combination may suppress it:
    // the failure mode is a user who can never sign in, with nothing on screen
    // to say why. `user-credentials-managerial` exposes no tenant pill at all.
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["admin", "company"] },
      error: null,
    });

    await notifyUserCredentials({ ...BASE, kind: "managerial" });

    const recipients = enqueue.mock.calls.map(
      (call) => (call[0] as { recipientAddress?: string }).recipientAddress,
    );
    expect(recipients).toContain("sara@example.test");
  });

  test("a tenant keeps their portal email when the tenant pill is off, losing only the WhatsApp copy", async () => {
    // The pill gates the WhatsApp duplicate of a message already sent by email,
    // never the email that carries the password itself.
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["admin", "company"] },
      error: null,
    });

    await notifyUserCredentials({ ...BASE, kind: "tenant", mobile: "+96550000000" });

    const channels = enqueue.mock.calls.map((call) => (call[0] as { channel?: string }).channel);
    expect(channels).toContain("email");
    expect(channels).not.toContain("whatsapp");
  });

  test("the tenant WhatsApp copy sends when the tenant pill is on", async () => {
    maybeSingle.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["admin", "company", "tenant"] },
      error: null,
    });

    await notifyUserCredentials({ ...BASE, kind: "tenant", mobile: "+96550000000" });

    const channels = enqueue.mock.calls.map((call) => (call[0] as { channel?: string }).channel);
    expect(channels).toContain("whatsapp");
  });

  test("the paused return still carries ids, so createAppUser keeps working", async () => {
    // createAppUser reads `.ids`. Replacing the shape rather than extending it
    // would turn a paused workflow into a crash at the call site.
    const result = await notifyUserCredentials({ ...BASE, kind: "managerial" });
    expect(Array.isArray(result.ids)).toBe(true);
  });
});

interface EnqueuedCredentialRow {
  channel?: string;
  audience?: string;
  recipientAddress?: string;
  payload?: { recipients?: string[] };
}

/**
 * يُفعّل مسار المستأجر بأهداف المستلمين المطلوبة للاختبار.
 *
 * `runEventWorkflow` passes the registry's `recipient_targets` straight
 * through as `targets`, and the mocked `resolveNotificationRecipients`
 * resolves an admin/company target to `admin@example.test` — so these tests
 * control the administrative copy without touching the mock factory.
 */
function activateTenantWorkflow(targets: string[]) {
  maybeSingle.mockResolvedValue({
    data: { is_active: true, recipient_targets: targets },
    error: null,
  });
}

/**
 * يجلب الصفوف المُدرجة في قائمة الانتظار بشكل مكتوب قابل للفحص.
 *
 * Reads the raw `enqueueNotification` arguments rather than re-deriving the
 * recipient logic: the point is what was actually enqueued, not what the
 * implementation computed internally.
 */
function enqueuedCredentialRows(): EnqueuedCredentialRow[] {
  return enqueue.mock.calls.map((call) => call[0] as EnqueuedCredentialRow);
}

/**
 * يمنح كل صف مُدرج معرّفاً مشتقاً من وجهته، لتمييز الصفوف دون افتراض ترتيبها.
 *
 * Every test below finds rows by audience rather than by call order, so the
 * suite survives a reordering of the enqueue calls. The default mock returns
 * one shared id, which cannot tell the tenant row from the admin copy.
 */
function identifyRowsByDestination() {
  enqueue.mockImplementation((row: unknown) => {
    const typed = row as EnqueuedCredentialRow;
    return { id: `${typed.channel}:${typed.audience}:${typed.recipientAddress}` };
  });
}

describe("the tenant credentials email is split from the administrative copy", () => {
  // Codex P1 on PR #206: the tenant path CC'd the admins on the SAME row, so
  // `payload.recipients` mixed the account owner with administrative
  // addresses and `ids` alone could not say who actually got their password.
  test("the tenant email goes to the tenant alone while admins get their own row", async () => {
    activateTenantWorkflow(["admin", "company"]);
    identifyRowsByDestination();

    await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(enqueue).toHaveBeenCalledTimes(2);
    const rows = enqueuedCredentialRows();
    const tenantRow = rows.find((row) => row.audience === "tenant");
    const adminRow = rows.find((row) => row.audience === "admin");
    expect(tenantRow?.recipientAddress).toBe("sara@example.test");
    expect(tenantRow?.payload?.recipients).toEqual(["sara@example.test"]);
    expect(adminRow?.payload?.recipients).toContain("admin@example.test");
    expect(adminRow?.payload?.recipients).not.toContain("sara@example.test");
  });

  test("an accepted admin copy never reports the owner as notified", async () => {
    // This is the whole point of the split: `recipientIds` answers "was the
    // customer told?", and a delivered admin copy must not answer it.
    activateTenantWorkflow(["admin", "company"]);
    identifyRowsByDestination();

    const result = await notifyUserCredentials({ ...BASE, kind: "tenant" });

    const tenantIndex = enqueuedCredentialRows().findIndex((row) => row.audience === "tenant");
    expect(tenantIndex).toBeGreaterThanOrEqual(0);
    expect(result.ids).toHaveLength(2);
    expect(result.recipientIds).toEqual([result.ids[tenantIndex]]);
    const adminId = result.ids.find((id) => !result.recipientIds.includes(id));
    expect(adminId).toBeDefined();
  });

  test("a tenant with no separate admin addresses gets only their own row", async () => {
    // No admin/company target resolves to nobody, so there is no second row
    // to enqueue — and nothing to exclude from `recipientIds` either.
    activateTenantWorkflow(["tenant"]);

    const result = await notifyUserCredentials({ ...BASE, kind: "tenant" });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [row] = enqueuedCredentialRows();
    expect(row.audience).toBe("tenant");
    expect(row.recipientAddress).toBe("sara@example.test");
    expect(result.ids).toHaveLength(1);
    expect(result.recipientIds).toEqual(result.ids);
  });

  test("the WhatsApp duplicate still goes to the tenant number alone", async () => {
    // The split touches the email leg only. The WhatsApp copy is already
    // owner-directed (tenant audience, tenant number), so it keeps its
    // behaviour — including counting towards `recipientIds`.
    activateTenantWorkflow(["admin", "company", "tenant"]);
    identifyRowsByDestination();

    const result = await notifyUserCredentials({
      ...BASE,
      kind: "tenant",
      mobile: "+96550000000",
    });

    const whatsapp = enqueuedCredentialRows().find((row) => row.channel === "whatsapp");
    expect(whatsapp?.audience).toBe("tenant");
    expect(whatsapp?.recipientAddress).toBe("+96550000000");
    expect(result.recipientIds).toContain("whatsapp:tenant:+96550000000");
    expect(result.recipientIds).toContain("email:tenant:sara@example.test");
  });
});
