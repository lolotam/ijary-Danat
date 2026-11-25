import { beforeEach, describe, expect, test, vi } from "vitest";

import { runLogRetentionJob } from "@/fns/logRetentionJob";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: vi.fn() },
}));

const rpc = vi.mocked(supabaseAdmin.rpc);

describe("runLogRetentionJob", () => {
  beforeEach(() => rpc.mockReset());

  test("returns what purge_expired_logs reports", async () => {
    const outcome = {
      audit: { days: 7, deleted: 12 },
      notifications: { days: null, deleted: 0 },
    };
    rpc.mockResolvedValue({ data: outcome, error: null } as never);

    await expect(runLogRetentionJob()).resolves.toEqual(outcome);
    expect(rpc).toHaveBeenCalledWith("purge_expired_logs");
  });

  test("an RPC error fails the job so the cron run is recorded as an error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } } as never);

    await expect(runLogRetentionJob()).rejects.toThrow("Log retention failed: boom");
  });
});
