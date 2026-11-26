import { beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  preRead: {
    disconnect_alert_armed: true,
    last_connection_state: "close" as string | null,
  } as { disconnect_alert_armed: boolean; last_connection_state: string | null } | null,
  preReadError: null as { message: string } | null,
  providerEnabled: true,
  providerError: null as { message: string } | null,
  workflowRow: { is_active: true, recipient_targets: ["admin", "company"] } as {
    is_active: boolean;
    recipient_targets: string[];
  } | null,
  claimRows: [
    {
      instance_name: "danat",
      connected_number: "96550000000",
      last_connection_state: "close",
      disconnected_at: "2026-11-11T07:10:00Z",
    },
  ] as Array<{
    instance_name: string;
    connected_number: string | null;
    last_connection_state: string | null;
    disconnected_at: string | null;
  }>,
  parkedCount: 12,
  cronReads: 0,
  claimAttempts: 0,
  evolutionUpdates: [] as Array<Record<string, unknown>>,
  evolutionUpdateCalls: [] as Array<{
    values: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
};

const rpc = vi.fn();
const enqueue = vi.fn();
const resolveRecipients = vi.fn(async (targets: string[]) =>
  targets.includes("admin") ? ["admin@example.test"] : [],
);

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
      if (table === "evolution_connections") {
        const chain: any = {
          _update: null as Record<string, unknown> | null,
          _filters: [] as Array<[string, ...unknown[]]>,
          select: () => chain,
          eq: (col: string, val: unknown) => {
            chain._filters.push(["eq", col, val]);
            return chain;
          },
          neq: (col: string, val: unknown) => {
            chain._filters.push(["neq", col, val]);
            return chain;
          },
          not: (col: string, op: string, val: unknown) => {
            chain._filters.push(["not", col, op, val]);
            return chain;
          },
          or: (expr: string) => {
            chain._filters.push(["or", expr]);
            return chain;
          },
          maybeSingle: async () => ({ data: state.preRead, error: state.preReadError }),
          update(values: Record<string, unknown>) {
            chain._update = values;
            chain._filters = [];
            state.evolutionUpdates.push(values);
            if (values.disconnect_alert_armed === false) state.claimAttempts += 1;
            return chain;
          },
          then: (onFulfilled: (value: unknown) => unknown) => {
            if (chain._update) {
              state.evolutionUpdateCalls.push({
                values: chain._update,
                filters: [...chain._filters],
              });
              if (chain._update.disconnect_alert_armed === false && state.claimRows.length > 0) {
                const claimed = state.claimRows;
                state.claimRows = [];
                if (state.preRead) state.preRead.disconnect_alert_armed = false;
                return Promise.resolve({ data: claimed, error: null }).then(onFulfilled);
              }
              if (chain._update.disconnect_alert_armed === true) {
                if (state.preRead && state.preRead.last_connection_state !== "open") {
                  state.preRead.disconnect_alert_armed = true;
                }
                return Promise.resolve({ data: null, error: null }).then(onFulfilled);
              }
            }
            const res =
              chain._update?.disconnect_alert_armed === false
                ? { data: state.claimRows, error: null }
                : { data: null, error: null };
            return Promise.resolve(res).then(onFulfilled);
          },
        };
        return chain;
      }
      if (table === "provider_configs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.providerError ? null : { is_enabled: state.providerEnabled },
                error: state.providerError,
              }),
            }),
          }),
        };
      }
      if (table === "cron_jobs") {
        state.cronReads += 1;
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.workflowRow, error: null }),
            }),
          }),
        };
      }
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { default_locale: "en", currency: "KWD" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "notification_templates") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "notifications") {
        return {
          select: () => ({
            in: () => ({
              in: async () => ({ count: state.parkedCount, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: (...args: unknown[]) => resolveRecipients(...(args as [string[]])),
}));

const { notifyWhatsappSessionDisconnected } = await import("./notifyWhatsappSessionDisconnected");

beforeEach(() => {
  vi.clearAllMocks();
  state.preRead = { disconnect_alert_armed: true, last_connection_state: "close" };
  state.preReadError = null;
  state.providerEnabled = true;
  state.providerError = null;
  state.workflowRow = { is_active: true, recipient_targets: ["admin", "company"] };
  state.claimRows = [
    {
      instance_name: "danat",
      connected_number: "96550000000",
      last_connection_state: "close",
      disconnected_at: "2026-11-11T07:10:00Z",
    },
  ];
  state.parkedCount = 12;
  state.cronReads = 0;
  state.claimAttempts = 0;
  state.evolutionUpdates = [];
  state.evolutionUpdateCalls = [];
  rpc.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notif-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("notifyWhatsappSessionDisconnected", () => {
  test("1: armed and disconnected claims atomically, formats Asia/Kuwait time in email body, and keeps ISO in payload", async () => {
    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({ skipped: false, notification: { id: "notif-1" } });
    expect(state.evolutionUpdateCalls).toEqual([
      {
        values: { disconnect_alert_armed: false },
        filters: [
          ["eq", "id", 1],
          ["eq", "disconnect_alert_armed", true],
          ["neq", "last_connection_state", "open"],
        ],
      },
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const enqueued = enqueue.mock.calls[0][0];
    expect(enqueued).toMatchObject({
      type: "whatsapp_session_alert",
      channel: "email",
      audience: "admin",
      templateCode: "whatsapp-session-disconnected",
      payload: {
        source: "webhook",
        observed_state: "close",
        disconnected_at: "2026-11-11T07:10:00Z",
        recipients: ["admin@example.test"],
      },
    });
    // 07:10 UTC is 10:10 in Asia/Kuwait (UTC+3); raw ISO must not leak into email copy.
    expect(enqueued.body).toContain("10:10");
    expect(enqueued.body).not.toContain("07:10:00Z");
  });

  test("1b: null disconnected_at renders a dash placeholder in the email body", async () => {
    state.claimRows = [
      {
        instance_name: "danat",
        connected_number: null,
        last_connection_state: "close",
        disconnected_at: null,
      },
    ];

    const result = await notifyWhatsappSessionDisconnected({ source: "send" });

    expect(result).toMatchObject({ skipped: false });
    expect(enqueue.mock.calls[0][0].body).toContain("<strong>Disconnected at:</strong> -");
  });

  test("2: unarmed skips before reading cron_jobs, recording a run, or enqueueing", async () => {
    state.preRead = { disconnect_alert_armed: false, last_connection_state: "close" };

    const result = await notifyWhatsappSessionDisconnected({ source: "send" });

    expect(result).toMatchObject({ skipped: true, benign: true });
    expect(state.cronReads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("3: losing the atomic claim returns benign skipped", async () => {
    state.claimRows = [];

    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({
      skipped: true,
      benign: true,
      reason: "Already alerted for this outage.",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("4: disabled evolution_api provider exits without touching cron_jobs or claiming", async () => {
    state.providerEnabled = false;

    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({ skipped: true, benign: true });
    expect(state.cronReads).toBe(0);
    expect(state.claimAttempts).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("5: paused workflow returns skipped and never claims", async () => {
    state.workflowRow = { is_active: false, recipient_targets: ["admin"] };

    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({ skipped: true, benign: true });
    expect(state.claimAttempts).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("6: no recipients returns skipped with reason and preserves arming (no claim)", async () => {
    resolveRecipients.mockResolvedValueOnce([]);

    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({
      skipped: true,
      reason: "No admin email recipients configured.",
    });
    expect(state.claimAttempts).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("7: enqueueNotification throwing re-arms the claim (guarding open/disconnecting) and never throws", async () => {
    enqueue.mockRejectedValueOnce(new Error("insert failed"));

    const result = await notifyWhatsappSessionDisconnected({ source: "send" });

    expect(result).toMatchObject({ skipped: true, reason: "insert failed" });
    expect(state.evolutionUpdateCalls).toEqual([
      {
        values: { disconnect_alert_armed: false },
        filters: [
          ["eq", "id", 1],
          ["eq", "disconnect_alert_armed", true],
          ["neq", "last_connection_state", "open"],
        ],
      },
      {
        values: { disconnect_alert_armed: true },
        filters: [
          ["eq", "id", 1],
          ["not", "last_connection_state", "in", "(open,disconnecting)"],
          ["or", "connected_number.not.is.null,connected_at.not.is.null"],
        ],
      },
    ]);
  });

  test("8: enqueueNotification returning null re-arms the claim", async () => {
    enqueue.mockResolvedValueOnce(null);

    const result = await notifyWhatsappSessionDisconnected({ source: "webhook" });

    expect(result).toMatchObject({
      skipped: true,
      reason: "Template whatsapp-session-disconnected excludes the email channel.",
    });
    expect(state.evolutionUpdateCalls).toEqual([
      {
        values: { disconnect_alert_armed: false },
        filters: [
          ["eq", "id", 1],
          ["eq", "disconnect_alert_armed", true],
          ["neq", "last_connection_state", "open"],
        ],
      },
      {
        values: { disconnect_alert_armed: true },
        filters: [
          ["eq", "id", 1],
          ["not", "last_connection_state", "in", "(open,disconnecting)"],
          ["or", "connected_number.not.is.null,connected_at.not.is.null"],
        ],
      },
    ]);
  });

  test("9: same episode suppresses a second send, while a re-armed episode fires immediately with no cooldown", async () => {
    const first = await notifyWhatsappSessionDisconnected({ source: "webhook" });
    expect(first).toMatchObject({ skipped: false });

    // Second call in the same outage episode is suppressed by the consumed claim.
    const duplicate = await notifyWhatsappSessionDisconnected({ source: "send" });
    expect(duplicate).toMatchObject({ skipped: true, benign: true });
    expect(enqueue).toHaveBeenCalledTimes(1);

    // Re-scan re-arms a new episode (full trigger cycle covered in whatsappSessionGuard.sqltest.ts #29);
    // next disconnect 5 minutes later alerts immediately without any time cooldown.
    state.preRead = { disconnect_alert_armed: true, last_connection_state: "close" };
    state.claimRows = [
      {
        instance_name: "danat",
        connected_number: "96550000000",
        last_connection_state: "close",
        disconnected_at: "2026-11-11T07:15:00Z",
      },
    ];
    const second = await notifyWhatsappSessionDisconnected({ source: "webhook" });
    expect(second).toMatchObject({ skipped: false });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  test("10: database errors on preRead or provider_configs log console.error and return non-benign skip", async () => {
    state.preReadError = { message: "connection read timeout" };
    const first = await notifyWhatsappSessionDisconnected({ source: "webhook" });
    expect(first).toEqual({ skipped: true, reason: "connection read timeout" });
    expect(console.error).toHaveBeenCalledWith(
      "[notifyWhatsappSessionDisconnected] failed to read session state",
      "connection read timeout",
    );

    vi.mocked(console.error).mockClear();
    state.preReadError = null;
    state.providerError = { message: "provider lookup failed" };
    const second = await notifyWhatsappSessionDisconnected({ source: "send" });
    expect(second).toEqual({ skipped: true, reason: "provider lookup failed" });
    expect(console.error).toHaveBeenCalledWith(
      "[notifyWhatsappSessionDisconnected] failed to read provider config",
      "provider lookup failed",
    );
  });
});
