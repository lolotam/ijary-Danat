import { beforeEach, describe, expect, test, vi } from "vitest";

const companyMaybeSingle = vi.fn();
const adminRolesResult = vi.fn();
const profilesResult = vi.fn();
const from = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}));

vi.mock("@/fns/dispatchNotification", () => ({
  dispatchNotificationRecord: vi.fn(),
}));

const { resolveNotificationRecipients, enqueueNotification, pickExistingDelivery } =
  await import("./enqueueNotification");
const { dispatchNotificationRecord } = await import("@/fns/dispatchNotification");
const dispatchMock = vi.mocked(dispatchNotificationRecord);

function mockCompany(email: string | null, error: { message: string } | null = null) {
  companyMaybeSingle.mockResolvedValue({
    data: email ? { email } : null,
    error,
  });
}

function mockAdmins(
  roles: { user_id: string }[] | null,
  rolesError: { message: string } | null,
  profileEmails: (string | null)[],
  profilesError: { message: string } | null = null,
) {
  adminRolesResult.mockResolvedValue({ data: roles, error: rolesError });
  profilesResult.mockResolvedValue({
    data: profileEmails.map((email) => ({ email })),
    error: profilesError,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation((table: string) => {
    if (table === "companies") {
      return {
        select: () => ({
          order: () => ({
            limit: () => ({ maybeSingle: companyMaybeSingle }),
          }),
        }),
      };
    }
    if (table === "user_roles") {
      return {
        select: () => ({
          eq: () => adminRolesResult(),
        }),
      };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          in: () => ({
            eq: () => profilesResult(),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  mockCompany("company@example.test");
  mockAdmins([{ user_id: "admin-1" }], null, ["admin@example.test"]);
});

describe("resolveNotificationRecipients", () => {
  test("admin + company merges both sources, lowercased and deduped", async () => {
    mockCompany("Company@Example.TEST");
    mockAdmins([{ user_id: "a1" }, { user_id: "a2" }], null, [
      "Admin@Example.TEST",
      "company@example.test",
    ]);

    await expect(resolveNotificationRecipients(["admin", "company"])).resolves.toEqual([
      "company@example.test",
      "admin@example.test",
    ]);
  });

  test("company alone returns only the company email", async () => {
    await expect(resolveNotificationRecipients(["company"])).resolves.toEqual([
      "company@example.test",
    ]);
    // Must not have queried user_roles / profiles.
    expect(from.mock.calls.map(([t]) => t)).toEqual(["companies"]);
  });

  test("admin alone returns only profile emails and never queries companies", async () => {
    await expect(resolveNotificationRecipients(["admin"])).resolves.toEqual(["admin@example.test"]);
    expect(from.mock.calls.map(([t]) => t)).toEqual(["user_roles", "profiles"]);
  });

  test("tenant alone returns an empty list without querying", async () => {
    // tenant is block-level in senders; the resolver ignores it.
    await expect(resolveNotificationRecipients(["tenant"])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  test("company error throws", async () => {
    mockCompany(null, { message: "companies down" });
    await expect(resolveNotificationRecipients(["company"])).rejects.toThrow(/companies down/);
  });

  test("admin profile errors are swallowed", async () => {
    mockAdmins(null, { message: "roles down" }, []);
    await expect(resolveNotificationRecipients(["admin"])).resolves.toEqual([]);
  });

  test("filters addresses that lack @", async () => {
    mockCompany("not-an-email");
    mockAdmins([{ user_id: "a1" }], null, ["also-bad", "ok@example.test"]);
    await expect(resolveNotificationRecipients(["admin", "company"])).resolves.toEqual([
      "ok@example.test",
    ]);
  });
});

describe("the template channel gates row creation", () => {
  const templateMaybeSingle = vi.fn();
  const insertSingle = vi.fn();
  const insertSpy = vi.fn();

  beforeEach(() => {
    from.mockImplementation((table: string) => {
      if (table === "notification_templates") {
        // One `.eq("code", …)` only — the gate reads the channel of an inactive
        // template too, so there is no `.eq("is_active", true)` here.
        return { select: () => ({ eq: () => ({ maybeSingle: templateMaybeSingle }) }) };
      }
      return {
        insert: (row: unknown) => {
          insertSpy(row);
          return { select: () => ({ single: insertSingle }) };
        },
      };
    });
    insertSingle.mockResolvedValue({
      data: { id: "n-1", scheduled_at: null },
      error: null,
    });
  });

  test("an email-only template drops a whatsapp row before it is inserted", async () => {
    // Never created, not created-then-skipped: the Notification Log is a
    // user-facing audit surface, and a skipped WhatsApp row for a template the
    // admin set to Email is the complaint rather than evidence.
    templateMaybeSingle.mockResolvedValue({ data: { channel: "email" }, error: null });

    const row = await enqueueNotification({
      type: "overdue_reminder",
      channel: "whatsapp",
      templateCode: "overdue-reminder",
      dispatch: false,
    });

    expect(row).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  test("a both template inserts the whatsapp row", async () => {
    templateMaybeSingle.mockResolvedValue({ data: { channel: "both" }, error: null });

    const row = await enqueueNotification({
      type: "overdue_reminder",
      channel: "whatsapp",
      templateCode: "overdue-reminder",
      dispatch: false,
    });

    expect(row).not.toBeNull();
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  test("a caller passing no template code is never gated", async () => {
    // Scheduled reports insert with template_code unset; the gate must not
    // invent a restriction where the admin never expressed one.
    const row = await enqueueNotification({
      type: "scheduled_report",
      channel: "email",
      dispatch: false,
    });

    expect(row).not.toBeNull();
    expect(templateMaybeSingle).not.toHaveBeenCalled();
  });

  test("a missing template row imposes no restriction", async () => {
    templateMaybeSingle.mockResolvedValue({ data: null, error: null });

    const row = await enqueueNotification({
      type: "receipt",
      channel: "whatsapp",
      templateCode: "receipt",
      dispatch: false,
    });

    expect(row).not.toBeNull();
  });

  test("deactivating a template does not re-arm the WhatsApp rows", async () => {
    // Copy and channel degrade in opposite directions: an inactive template
    // falls back to built-in wording, but its channel is still the last thing
    // the admin chose. If the gate skipped inactive rows, unchecking "active"
    // would silently restore the original defect.
    templateMaybeSingle.mockResolvedValue({
      data: { channel: "email", is_active: false },
      error: null,
    });

    const row = await enqueueNotification({
      type: "receipt",
      channel: "whatsapp",
      templateCode: "receipt",
      dispatch: false,
    });

    expect(row).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  test("account provisioning may opt out of the gate", async () => {
    // A user-credentials template set to WhatsApp-only must not suppress the
    // email that carries the password, or the account can never sign in.
    templateMaybeSingle.mockResolvedValue({ data: { channel: "whatsapp" }, error: null });

    const row = await enqueueNotification({
      type: "user_credentials",
      channel: "email",
      templateCode: "user-credentials",
      bypassTemplateChannel: true,
      dispatch: false,
    });

    expect(row).not.toBeNull();
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the tenant pause switch holds tenant-bound notifications back", () => {
  const tenantMaybeSingle = vi.fn();
  const insertSingle = vi.fn();
  const insertSpy = vi.fn();

  beforeEach(() => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        // `.select("notifications_paused").eq("id", …).maybeSingle()`.
        return { select: () => ({ eq: () => ({ maybeSingle: tenantMaybeSingle }) }) };
      }
      return {
        insert: (row: unknown) => {
          insertSpy(row);
          return { select: () => ({ single: () => insertSingle(row) }) };
        },
      };
    });
    // Echoes the inserted row back, the way the real client returns it: the
    // function reads `scheduled_at` from the insert result, so a stub that
    // answers `null` would hide the scheduled-window rule.
    insertSingle.mockImplementation(async (row: Record<string, unknown>) => ({
      data: { ...row, id: "n-1" },
      error: null,
    }));
  });

  test("a tenant-audience row for a paused tenant is skipped, not sent", async () => {
    tenantMaybeSingle.mockResolvedValue({ data: { notifications_paused: true }, error: null });

    const row = await enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "tenant",
      tenantId: "t-1",
    });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.state).toBe("skipped");
    expect(inserted.failure_reason).toBe("Tenant notifications are paused.");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(row).not.toBeNull();
  });

  test("a paused tenant with dispatch off is queued, not skipped", async () => {
    // The row is not sent now, so the switch is not read at all: unpausing
    // the tenant before the caller dispatches it must still deliver it.
    tenantMaybeSingle.mockResolvedValue({ data: { notifications_paused: true }, error: null });

    await enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "tenant",
      tenantId: "t-1",
      dispatch: false,
    });

    expect(tenantMaybeSingle).not.toHaveBeenCalled();
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.state).toBe("queued");
    expect(inserted.failure_reason).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("a paused tenant scheduled for later is queued, not skipped", async () => {
    // The row waits for its time, so the switch is read when it is sent:
    // unpausing the tenant before then must still deliver it.
    tenantMaybeSingle.mockResolvedValue({ data: { notifications_paused: true }, error: null });

    await enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "tenant",
      tenantId: "t-1",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(tenantMaybeSingle).not.toHaveBeenCalled();
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.state).toBe("queued");
    expect(inserted.failure_reason).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("an admin-audience row for the same tenant is queued and sent", async () => {
    // The admin copy is the office's, not the tenant's — a paused tenant must
    // not silence the office, and the pause is never even read for it.
    tenantMaybeSingle.mockResolvedValue({ data: { notifications_paused: true }, error: null });

    await enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "admin",
      tenantId: "t-1",
    });

    expect(tenantMaybeSingle).not.toHaveBeenCalled();
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.state).toBe("queued");
    expect(inserted.failure_reason).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith("n-1");
  });

  test("a tenant-audience row for an unpaused tenant behaves as before", async () => {
    tenantMaybeSingle.mockResolvedValue({ data: { notifications_paused: false }, error: null });

    await enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "tenant",
      tenantId: "t-1",
    });

    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.state).toBe("queued");
    expect(inserted.failure_reason).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith("n-1");
  });

  test("a tenant row that cannot be read is not treated as unpaused", async () => {
    // Fail closed: a pause nobody could read must not become a tenant that
    // gets reached anyway.
    tenantMaybeSingle.mockResolvedValue({ data: null, error: { message: "tenants down" } });

    const pending = enqueueNotification({
      type: "overdue_reminder",
      channel: "email",
      audience: "tenant",
      tenantId: "t-1",
    });

    await expect(pending).rejects.toThrow(/tenants down/);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("a duplicate delivery key returns the row that already exists", () => {
  const insertSingle = vi.fn();
  const existingRows = vi.fn();
  let stateFilters: unknown[];

  beforeEach(() => {
    stateFilters = [];
    insertSingle.mockReset();
    existingRows.mockReset();
    insertSingle.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    from.mockImplementation((table: string) => {
      if (table === "notifications") {
        return {
          insert: () => ({ select: () => ({ single: insertSingle }) }),
          // `.select("*").eq("delivery_key", …).in("state", …).order(…)`
          // resolves to `{ data, error }` — one row set, not a single row. The
          // chain ends there on purpose: a `.limit(…)` would have nothing to
          // call, so the mock refuses any cap on the lookup.
          select: () => ({
            eq: () => ({
              in: (_column: string, states: unknown) => {
                stateFilters.push(states);
                return {
                  order: () => existingRows(),
                };
              },
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  /** يرسل إشعاراً بمفتاح تسليم ثابت لاختبار تعارض المفتاح الفريد. */
  function enqueueWithKey() {
    return enqueueNotification({
      type: "receipt",
      channel: "email",
      audience: "admin",
      deliveryKey: "receipt:email:abc",
    });
  }

  test("a sent row wins over a newer failed row under the same key", async () => {
    // The contract-expiry job can leave newer failed or skipped rows under the
    // same key; the delivery itself is the queued/sent row, so it is the one
    // returned.
    existingRows.mockResolvedValue({
      data: [
        { id: "n-failed", state: "failed", created_at: "2026-10-20T09:00:00.000Z" },
        { id: "n-sent", state: "sent", created_at: "2026-10-19T09:00:00.000Z" },
      ],
      error: null,
    });

    const row = await enqueueWithKey();

    expect(row).toMatchObject({ id: "n-sent", state: "sent" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("a sent row older than 25 newer skipped rows is still the delivery", async () => {
    // A paused tenant leaves one skipped row per day under the contract-expiry
    // key, so a capped lookup would stop short of the `sent` row that is the
    // delivery itself and report a conflict nobody caused.
    const skipped = Array.from({ length: 25 }, (_unused, index) => ({
      id: `n-skipped-${index}`,
      state: "skipped",
      created_at: new Date(Date.UTC(2026, 9, 20 + index)).toISOString(),
    }));
    existingRows.mockResolvedValue({
      data: [...skipped, { id: "n-sent", state: "sent", created_at: "2026-09-01T09:00:00.000Z" }],
      error: null,
    });

    const row = await enqueueWithKey();

    expect(row).toMatchObject({ id: "n-sent", state: "sent" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("with no queued or sent row, the failed row is returned instead of a new one", async () => {
    // The row the payment index refused may be the FAILED one the drain job
    // will retry. Returning it makes that retry reuse the same row.
    existingRows.mockResolvedValue({
      data: [{ id: "n-failed", state: "failed", created_at: "2026-10-20T09:00:00.000Z" }],
      error: null,
    });

    const row = await enqueueWithKey();

    expect(row).toMatchObject({ id: "n-failed", state: "failed" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("one lookup reads every dispatchable state at once", async () => {
    // Two queries read two snapshots, so a row that moved from `failed` to
    // `sent` between them was missed by both. One query cannot straddle that.
    existingRows.mockResolvedValue({
      data: [{ id: "n-sent", state: "sent", created_at: "2026-10-19T09:00:00.000Z" }],
      error: null,
    });

    await enqueueWithKey();

    expect(stateFilters).toEqual([["queued", "sent", "failed", "needs_review", "skipped"]]);
  });

  test("a failed lookup throws its own error", async () => {
    existingRows.mockResolvedValue({ data: null, error: { message: "notifications down" } });

    await expect(enqueueWithKey()).rejects.toThrow(/notifications down/);
  });

  test("with no matching row the duplicate error is rethrown", async () => {
    // Nothing to reuse: the caller must see the original conflict, not a
    // silently missing row.
    existingRows.mockResolvedValue({ data: [], error: null });

    await expect(enqueueWithKey()).rejects.toThrow(/duplicate key value/);
  });
});

describe("pickExistingDelivery", () => {
  test("a queued or sent row wins over a newer skipped row", () => {
    // The delivery itself, not the newer row the contract-expiry job left
    // behind under the same key.
    const rows = [
      { id: "n-skipped", state: "skipped", created_at: "2026-10-20T09:00:00.000Z" },
      { id: "n-queued", state: "queued", created_at: "2026-10-19T09:00:00.000Z" },
    ];

    expect(pickExistingDelivery(rows)).toMatchObject({ id: "n-queued" });
  });

  test("with no queued or sent row the newest row wins", () => {
    const rows = [
      { id: "n-newer", state: "failed", created_at: "2026-10-20T09:00:00.000Z" },
      { id: "n-older", state: "needs_review", created_at: "2026-10-19T09:00:00.000Z" },
    ];

    expect(pickExistingDelivery(rows)).toMatchObject({ id: "n-newer" });
  });

  test("an empty list has no delivery to pick", () => {
    expect(pickExistingDelivery([])).toBeUndefined();
  });
});
