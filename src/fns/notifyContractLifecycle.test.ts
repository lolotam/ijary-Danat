import { beforeEach, describe, expect, test, vi } from "vitest";

const serverHarness = vi.hoisted(() => {
  const serverFunction = Object.assign(
    (input: { data: unknown }) =>
      serverFunction.handler({ data: input.data, context: serverFunction.context }),
    {
      context: null as unknown,
      handler: null as unknown as (input: { data: any; context: any }) => Promise<unknown>,
    },
  );
  return { serverFunction };
});

const workflowRow = vi.fn();
const contractRow = vi.fn();
const existingNotifications = vi.fn();
const companyRow = vi.fn();
const tenantRow = vi.fn();
const contractUnitRow = vi.fn();
const unitsRow = vi.fn();
const templateRow = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const CONTRACT_ID = "66666666-6666-4666-8666-666666666666";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      inputValidator: () => ({
        handler: (handler: typeof serverHarness.serverFunction.handler) => {
          serverHarness.serverFunction.handler = handler;
          return serverHarness.serverFunction;
        },
      }),
    }),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

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
      if (table === "cron_jobs") {
        return { select: () => ({ eq: () => ({ maybeSingle: workflowRow }) }) };
      }
      if (table === "contracts") {
        return { select: () => ({ eq: () => ({ single: contractRow }) }) };
      }
      if (table === "notifications") {
        return {
          select: () => ({
            eq: () => ({
              contains: () => ({
                neq: () => ({ limit: existingNotifications }),
              }),
            }),
          }),
        };
      }
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: companyRow }),
          }),
        };
      }
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: tenantRow }) }) };
      }
      // contract_units: `.select("unit_id").eq("contract_id", …).order("line_order")`.
      if (table === "contract_units") {
        return { select: () => ({ eq: () => ({ order: () => contractUnitRow() }) }) };
      }
      // units are resolved through contract_units now (migration 110), via `.in(...)`.
      if (table === "units") {
        return { select: () => ({ in: () => unitsRow() }) };
      }
      if (table === "notification_templates") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

const resolveRecipients = vi.fn(async (targets: string[]) =>
  targets.includes("admin") || targets.includes("company")
    ? targets.includes("company") && !targets.includes("admin")
      ? ["company@example.test"]
      : ["admin@example.test"]
    : [],
);

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: (...args: unknown[]) => resolveRecipients(...(args as [string[]])),
}));

const { notifyContractCreatedRecord, notifyContractEndedRecord } =
  await import("./notifyContractLifecycle.server");
const { notifyContractLifecycle } = await import("./notifyContractLifecycle");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  contractRow.mockResolvedValue({
    data: {
      id: CONTRACT_ID,
      code: "CTR-1",
      tenant_id: "tenant-1",
      unit_id: "unit-1",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    },
    error: null,
  });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  companyRow.mockResolvedValue({ data: { default_locale: "en" }, error: null });
  tenantRow.mockResolvedValue({ data: { name: "Sara" }, error: null });
  contractUnitRow.mockResolvedValue({ data: [{ unit_id: "unit-1" }], error: null });
  unitsRow.mockResolvedValue({ data: [{ name: "Unit 12" }], error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the two contract workflows are independently switchable", () => {
  test("created records against contract-created", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyContractCreatedRecord(CONTRACT_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contract-created", _status: "skipped" }),
    );
  });

  test("ended records against contract-ended", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyContractEndedRecord(CONTRACT_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contract-ended", _status: "skipped" }),
    );
  });

  test("pausing created does not silence ended", async () => {
    workflowRow
      .mockResolvedValueOnce({ data: { is_active: false }, error: null })
      .mockResolvedValueOnce({ data: { is_active: true }, error: null });

    await notifyContractCreatedRecord(CONTRACT_ID);
    expect(enqueue).not.toHaveBeenCalled();

    await notifyContractEndedRecord(CONTRACT_ID);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

test("the enqueued templateCode is the unsuffixed stem", async () => {
  workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });

  await notifyContractCreatedRecord(CONTRACT_ID);

  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({ templateCode: "contract-created" }),
  );
});

test.each([
  ["created", notifyContractCreatedRecord],
  ["ended", notifyContractEndedRecord],
])("a paused %s workflow enqueues nothing", async (_event, notify) => {
  workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

  const result = await notify(CONTRACT_ID);

  expect(enqueue).not.toHaveBeenCalled();
  expect(result).toMatchObject({ skipped: true });
});

test.each([
  ["created", notifyContractCreatedRecord],
  ["ended", notifyContractEndedRecord],
])("an already-notified %s event records skipped", async (_event, notify) => {
  workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
  existingNotifications.mockResolvedValue({ data: [{ id: "existing" }], error: null });

  const result = await notify(CONTRACT_ID);

  expect(enqueue).not.toHaveBeenCalled();
  expect(result).toMatchObject({ skipped: true });
  expect(rpc).toHaveBeenCalledWith(
    "record_cron_run",
    expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
  );
});

test.each([
  ["created", "contracts.create"],
  ["ended", "contracts.update"],
] as const)("the %s event requires %s", (event, permission) => {
  const permissionRpc = vi.fn().mockResolvedValue({ data: true, error: null });
  serverHarness.serverFunction.context = {
    supabase: { rpc: permissionRpc },
    userId: "admin-1",
  };
  workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

  const callLifecycle = notifyContractLifecycle as unknown as typeof serverHarness.serverFunction;
  return callLifecycle({ data: { contractId: CONTRACT_ID, event } }).then(() => {
    expect(permissionRpc).toHaveBeenCalledWith("has_permission", {
      _code: permission,
      _user_id: "admin-1",
    });
  });
});

describe("recipient targets are address-level for admin/company", () => {
  test("admin off + company on still enqueues to the company email", async () => {
    workflowRow.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });

    await notifyContractCreatedRecord(CONTRACT_ID);

    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]?.recipientAddress).toBe("company@example.test");
  });
});
