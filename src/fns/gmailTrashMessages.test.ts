import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const serverFunction = Object.assign(
    (data: unknown) => serverFunction.handler({ data, context: serverFunction.context }),
    {
      context: null as unknown,
      handler: null as unknown as (input: { data: unknown; context: unknown }) => Promise<unknown>,
    },
  );
  return {
    serverFunction,
    readGmailGrant: vi.fn(),
    getGmailAccessToken: vi.fn().mockResolvedValue("access-token"),
    from: vi.fn(),
    fetch: vi.fn(),
    remove: vi.fn(),
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      handler: (handler: typeof mocks.serverFunction.handler) => {
        mocks.serverFunction.handler = handler;
        return mocks.serverFunction;
      },
    };
    return {
      middleware: () => ({ inputValidator: () => builder, validator: () => builder }),
    };
  },
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

vi.mock("@/lib/gmailClient.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gmailClient.server")>(
    "@/lib/gmailClient.server",
  );
  return {
    ...actual,
    readGmailGrant: mocks.readGmailGrant,
    getGmailAccessToken: mocks.getGmailAccessToken,
  };
});

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
  companyClient: () => ({ from: mocks.from }),
}));

import { stubHungFetch } from "@/lib/providers/hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

import { gmailTrashMessages } from "./gmailTrashMessages";

const ROW_ID = "11111111-1111-1111-1111-111111111111";

const modifiableGrant = {
  credentials: { clientId: "id", clientSecret: "secret", refreshToken: "r", address: "me" },
  connectionId: "conn-1",
  scope:
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
  emailAddress: "danatfuture@gmail.com",
};

function rowsReturning(rows: Array<Record<string, unknown>>) {
  mocks.from.mockReturnValue({
    select: () => ({ in: async () => ({ data: rows, error: null }) }),
    delete: () => ({ eq: mocks.remove }),
  });
}

function callTrash(ids: string[], isAdmin = true) {
  const fn = gmailTrashMessages as unknown as typeof mocks.serverFunction;
  fn.context = {
    supabase: { rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }) },
    userId: "admin-1",
  };
  return fn({ ids });
}

describe("gmailTrashMessages", () => {
  beforeEach(() => {
    mocks.readGmailGrant.mockReset().mockResolvedValue(modifiableGrant);
    mocks.from.mockReset();
    mocks.remove.mockReset().mockResolvedValue({ error: null });
    mocks.fetch.mockReset().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("trashes in Gmail and only then deletes the local row", async () => {
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    await expect(callTrash([ROW_ID])).resolves.toEqual({ trashed: 1, failed: [] });
    expect(mocks.fetch.mock.calls[0][0]).toContain("/messages/18f0c/trash");
    expect(mocks.remove).toHaveBeenCalledWith("id", ROW_ID);
  });

  it("keeps the local row when Gmail refuses the trash", async () => {
    // Deleting locally after a failed trash reproduces the reported bug: the
    // message vanishes from the app and the next sync brings it back.
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const result = (await callTrash([ROW_ID])) as { trashed: number; failed: unknown[] };
    expect(result.trashed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a connection granted before gmail.modify, with the reconnect instruction", async () => {
    mocks.readGmailGrant.mockResolvedValue({
      ...modifiableGrant,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    // Regression: this pre-flight message used to be a hand-written literal
    // that could drift from the in-loop 403 wording below. Both now go through
    // the same parameterised describeGmailApiError(status, body, "deleting"),
    // so this asserts the actual "deleting" wording, not just the shared
    // "Disconnect, then Connect Gmail again" instruction.
    const error = (await callTrash([ROW_ID]).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("before deleting was enabled");
    expect(error.message).toContain("Disconnect, then Connect Gmail again");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports a live 403 scope revocation in the trash loop as a deleting failure, not sending", async () => {
    // The stored `scope` column can go stale: an admin can revoke gmail.modify
    // at the Google Account level without disconnecting in-app. The pre-flight
    // check above reads the stale column and passes, so only this live 403 —
    // Gmail's actual response to the trash call — catches it. Regression: this
    // used to say "before sending was enabled" here because the in-loop 403
    // reused describeGmailApiError's default feature word.
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "insufficient authentication scopes",
    });
    const result = (await callTrash([ROW_ID])) as {
      trashed: number;
      failed: Array<{ id: string; reason: string }>;
    };
    expect(result.failed[0].reason).toContain("before deleting was enabled");
    expect(result.failed[0].reason).not.toContain("sending");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps partial progress when fetch throws for one message but succeeds for another", async () => {
    // A thrown fetch (DNS failure, socket reset, abort) must not reject the
    // whole handler: that would discard the {trashed, failed} accumulated for
    // every id already processed in this call, and the admin would see a bare
    // error toast instead of "1 deleted, 1 failed". Asserting on the resolved
    // value (not just counts) is deliberate: with the try/catch removed this
    // call rejects instead of resolving, and `await` on it throws the original
    // "network exploded" error — a failure tied to this test's own assertion,
    // not an unrelated mock-shape error.
    const ROW_ID_2 = "22222222-2222-2222-2222-222222222222";
    rowsReturning([
      { id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } },
      { id: ROW_ID_2, message_id: "<c@d>", raw_payload: { id: "29g1d" } },
    ]);
    mocks.fetch
      .mockRejectedValueOnce(new Error("network exploded"))
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    const result = (await callTrash([ROW_ID, ROW_ID_2])) as {
      trashed: number;
      failed: Array<{ id: string; reason: string }>;
    };

    expect(result.trashed).toBe(1);
    expect(result.failed).toEqual([{ id: ROW_ID, reason: "network exploded" }]);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("id", ROW_ID_2);
  });

  it("records a hung trash call as a failure and keeps the local row", async () => {
    // A bare fetch had no timeout, so a Gmail call that accepted the socket and
    // never answered held the admin's delete request open indefinitely.
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: { id: "18f0c" } }]);
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const trash = callTrash([ROW_ID]);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    fireTimeout();

    const result = (await trash) as { trashed: number; failed: unknown[] };
    expect(result).toMatchObject({ trashed: 0, failed: [{ id: ROW_ID }] });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a row whose Gmail id cannot be resolved rather than deleting it", async () => {
    rowsReturning([{ id: ROW_ID, message_id: "<a@b>", raw_payload: null }]);
    const result = (await callTrash([ROW_ID])) as { trashed: number; failed: unknown[] };
    expect(result.trashed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("rejects a caller without inbox.manage with an Error, not a Response", async () => {
    rowsReturning([]);
    const error = await callTrash([ROW_ID], false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Response);
    expect((gmailTrashMessages as any).context.supabase.rpc).toHaveBeenCalledWith(
      "has_permission",
      { _code: "inbox.manage", _user_id: "admin-1" },
    );
  });
});
