import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test, vi } from "vitest";

import type { Database } from "@/integrations/supabase/database.types";

import type { JobPayload } from "./catalog";
import { enqueueJob } from "./enqueue";

const INVOICE_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";

/** يبني عميل Supabase وهمياً يرد على `rpc` بالنتيجة المعطاة ويسجّل الاستدعاءات. */
function fakeDb(reply: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(reply);
  return { db: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

describe("enqueueJob (T061)", () => {
  test("a valid request becomes one enqueue_job call and returns its job id", async () => {
    const { db, rpc } = fakeDb({ data: "job-1", error: null });

    const result = await enqueueJob(
      db,
      "invoice.send",
      { invoiceId: INVOICE_ID, channel: "email" },
      { dedupeKey: `${INVOICE_ID}__email__2026-11-27`, requestedBy: STAFF_ID },
    );

    expect(result).toEqual({ jobId: "job-1" });
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "invoice.send",
      _payload: { invoiceId: INVOICE_ID, channel: "email" },
      _dedupe_key: `${INVOICE_ID}__email__2026-11-27`,
      _requested_by: STAFF_ID,
    });
  });

  test("a payload outside the catalogue schema never reaches the database", async () => {
    const { db, rpc } = fakeDb({ data: "job-1", error: null });
    const leaky = { invoiceId: INVOICE_ID, channel: "email", password: "x" } as unknown;

    await expect(
      enqueueJob(db, "invoice.send", leaky as JobPayload<"invoice.send">),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  test("a database refusal surfaces as an error naming the kind", async () => {
    const { db } = fakeDb({ data: null, error: { message: "COMPANY_REQUIRED" } });

    await expect(
      enqueueJob(db, "notification.dispatch", { notificationId: INVOICE_ID }),
    ).rejects.toThrow("enqueue_job(notification.dispatch) failed: COMPANY_REQUIRED");
  });
});
