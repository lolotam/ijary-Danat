import { describe, expect, it, vi } from "vitest";

// The registry resolves the cron handlers, whose work reads the platform
// registry through the service-role client. The unit tests never call it, so
// the real client must never be built.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));

import { CRON_JOBS } from "@/jobs/handlers/cron";
import { createHandlerRegistry } from "@/jobs/handlers/registry";
import { SCHEDULES } from "@/worker/scheduler";

describe("the handler registry", () => {
  it("resolves the notification handler and every document handler", () => {
    // `runJob` treats a missing handler as a permanent failure, so a kind that
    // is wired must be found and a kind that is not wired must read as absent
    // rather than as a no-op handler.
    const registry = createHandlerRegistry({ pace: vi.fn().mockResolvedValue(undefined) });

    expect(registry("notification.dispatch")).toBeTypeOf("function");
    expect(registry("invoice.send")).toBeTypeOf("function");
    expect(registry("payment.receipt")).toBeTypeOf("function");
    expect(registry("company.info.send")).toBeTypeOf("function");
    expect(registry("report.run")).toBeTypeOf("function");
  });

  it("leaves the kinds with no server function to move undefined", () => {
    // The contract PDF is a direct download for the browser and the reports
    // screen exports CSV in the browser: neither has a server function whose
    // slow work could move into a job, so no handler is invented for them.
    const registry = createHandlerRegistry({ pace: vi.fn().mockResolvedValue(undefined) });

    expect(registry("contract.pdf")).toBeUndefined();
    expect(registry("report.export")).toBeUndefined();
  });

  it.each(SCHEDULES)("resolves the handler of the $kind schedule", (schedule) => {
    // A kind the scheduler fans out without a handler fails permanently, so
    // the two lists have to agree.
    const registry = createHandlerRegistry({ pace: vi.fn().mockResolvedValue(undefined) });

    expect(registry(schedule.kind)).toBeTypeOf("function");
  });

  it.each(Object.entries(CRON_JOBS))(
    "the %s handler records under the key the fan-out reads",
    (kind, spec) => {
      // The fan-out reads the pause switch of one key and the handler records
      // the run under another if the two tables drift — and a job that reads
      // the wrong switch never pauses.
      const schedule = SCHEDULES.find((entry) => entry.kind === kind);
      expect(schedule?.registryKey).toBe(spec.registryKey);
    },
  );
});
