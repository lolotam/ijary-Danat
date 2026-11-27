import { describe, expect, it } from "vitest";

import { hasSqlState, runInChunks, type BulkRunResult } from "./bulkChunks";

/** عدّاد فارغ يبدأ منه كل اختبار تجميع. */
function emptyOutcome(): BulkRunResult {
  return { created: 0, skipped: 0, failed: 0, errors: [] };
}

describe("runInChunks", () => {
  it("reads 450 rows as 3 chunks of 200, 200 and 50 and sums the outcomes", async () => {
    const rows = Array.from({ length: 450 }, (_, index) => index);
    const loaded: number[] = [];
    const seen: number[] = [];

    const totals = await runInChunks<number>(
      async (offset, limit) => {
        loaded.push(offset);
        return rows.slice(offset, offset + limit);
      },
      async (chunk) => {
        seen.push(chunk.length);
        return { created: chunk.length, skipped: 0, failed: 0, errors: [] };
      },
    );

    // The loader is called per chunk — 0, 200, 400 — so the chunk boundary is
    // observable and a retry resumes from a real boundary, not from scratch.
    expect(loaded).toEqual([0, 200, 400]);
    expect(seen).toEqual([200, 200, 50]);
    expect(totals).toMatchObject({ created: 450, skipped: 0, failed: 0 });
  });

  it("stops at one partial chunk and does nothing for no rows", async () => {
    const partial = await runInChunks<number>(
      async (offset, limit) => [1, 2, 3, 4, 5, 6, 7].slice(offset, offset + limit),
      async (chunk) => ({ created: chunk.length, skipped: 0, failed: 0, errors: [] }),
    );
    expect(partial).toMatchObject({ created: 7 });

    let workCalls = 0;
    const empty = await runInChunks<number>(
      async () => [],
      async () => {
        workCalls += 1;
        return emptyOutcome();
      },
    );
    expect(empty).toMatchObject({ created: 0, skipped: 0, failed: 0 });
    expect(workCalls).toBe(0);
  });

  it("propagates a system error instead of counting it as a failed item", async () => {
    // A crash must stay a crash: BullMQ retries the job, and the rows already
    // committed are skipped on the rerun. Counting the crash as one failed
    // item would end the job "succeeded" with most rows never processed.
    await expect(
      runInChunks<number>(
        async () => [1, 2, 3],
        async () => {
          throw new Error("connection lost");
        },
      ),
    ).rejects.toThrow("connection lost");
  });

  it("collects per-item errors without stopping the chunk", async () => {
    const totals = await runInChunks<number>(
      async (offset, limit) => [1, 2, 3].slice(offset, offset + limit),
      async (chunk) => {
        const outcome = emptyOutcome();
        for (const row of chunk) {
          if (row === 2) {
            outcome.failed += 1;
            outcome.errors.push("row 2 refused");
            continue;
          }
          outcome.created += 1;
        }
        return outcome;
      },
    );

    expect(totals).toMatchObject({ created: 2, failed: 1, errors: ["row 2 refused"] });
  });
});

describe("hasSqlState", () => {
  it("recognises PostgREST/Postgres errors and nothing else", () => {
    expect(hasSqlState({ message: "Permission denied", code: "42501" })).toBe(true);
    expect(hasSqlState({ message: "fetch failed", code: "" })).toBe(false);
    expect(hasSqlState(new Error("boom"))).toBe(false);
    expect(hasSqlState(null)).toBe(false);
    expect(hasSqlState("code")).toBe(false);
  });
});
