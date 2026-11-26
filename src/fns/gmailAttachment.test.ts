import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = (input?: { data?: unknown }) =>
      fn._handler({ data: input?.data, context: fn._context });
    fn._context = {
      supabase: { rpc: async () => ({ data: true, error: null }) },
      userId: "staff-user",
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockImplementation(() => fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({
    server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const grantMock = vi.fn();

vi.mock("@/lib/gmailClient.server", () => ({
  GMAIL_API: "https://gmail.googleapis.com/gmail/v1/users",
  describeGmailApiError: (status: number) => `gmail api error ${status}`,
  readGmailGrant: () => grantMock(),
  getGmailAccessToken: async () => "access-token",
}));

const db = {
  message: null as Record<string, unknown> | null,
  storage: {} as Record<string, { bytes: Buffer; type: string }>,
  uploads: [] as string[],
};

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

vi.mock("@/company/companyClient.server", () => {
  function builder() {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: db.message, error: null }),
    };
    return chain;
  }
  const client = {
    from: () => builder(),
    storage: {
      from: () => ({
        download: (path: string) => {
          const file = db.storage[path];
          if (!file) return Promise.resolve({ data: null, error: { message: "not found" } });
          return Promise.resolve({
            data: {
              type: file.type,
              arrayBuffer: () =>
                Promise.resolve(
                  file.bytes.buffer.slice(
                    file.bytes.byteOffset,
                    file.bytes.byteOffset + file.bytes.byteLength,
                  ),
                ),
            },
            error: null,
          });
        },
        upload: (path: string, bytes: Buffer, opts: { contentType: string }) => {
          db.storage[path] = { bytes, type: opts.contentType };
          db.uploads.push(path);
          return Promise.resolve({ data: { path }, error: null });
        },
      }),
    },
  };
  return {
    companyClient: () => client,
  };
});

import { stubHungFetch } from "@/lib/providers/hungProvider.fixture";
import { PROVIDER_TIMEOUT_MS } from "@/lib/providers/types";

import { gmailAttachment } from "./gmailAttachment";

const MESSAGE_ROW_ID = "11111111-1111-1111-1111-111111111111";

function messageWithAttachment() {
  return {
    raw_payload: {
      id: "gmail-msg-1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            filename: "lease.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-1", size: 2048 },
          },
        ],
      },
    },
  };
}

describe("gmailAttachment caching", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    db.message = messageWithAttachment();
    db.storage = {};
    db.uploads = [];
    grantMock.mockResolvedValue({ credentials: { address: "inbox@example.test" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches a cache miss from Gmail and stores the bytes for next time", async () => {
    const base64url = Buffer.from("%PDF-1.7 lease").toString("base64url");
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: base64url }), { status: 200 }),
    );

    const result = await gmailAttachment({
      data: { messageId: MESSAGE_ROW_ID, attachmentId: "att-1" },
    });

    expect(result).toMatchObject({ filename: "lease.pdf", data: base64url });
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toMatch(
      new RegExp(
        `^companies/${TEST_COMPANY.id}/message/${MESSAGE_ROW_ID}/[0-9a-f]{16}/lease\\.pdf$`,
      ),
    );
    expect(db.storage[db.uploads[0]].bytes.toString()).toBe("%PDF-1.7 lease");
  });

  it("serves a repeat download from the bucket without Gmail or the grant", async () => {
    const first = Buffer.from("%PDF-1.7 lease");
    // Prime the cache through the real path shape.
    const base64url = first.toString("base64url");
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: base64url }), { status: 200 }),
    );
    await gmailAttachment({ data: { messageId: MESSAGE_ROW_ID, attachmentId: "att-1" } });
    vi.mocked(globalThis.fetch).mockClear();
    grantMock.mockClear();
    // Even a disconnected mailbox must not break a cached download.
    grantMock.mockResolvedValue(null);

    const result = await gmailAttachment({
      data: { messageId: MESSAGE_ROW_ID, attachmentId: "att-1" },
    });

    expect(result.data).toBe(base64url);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(grantMock).not.toHaveBeenCalled();
  });

  it("gives up on a hung download with the long attachment limit and caches nothing", async () => {
    const { fireTimeout, timeoutSpy } = stubHungFetch();

    const download = gmailAttachment({
      data: { messageId: MESSAGE_ROW_ID, attachmentId: "att-1" },
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    fireTimeout();

    await expect(download).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS * 3);
    expect(db.uploads).toHaveLength(0);
  });

  it("still refuses an attachment the message does not declare", async () => {
    await expect(
      gmailAttachment({ data: { messageId: MESSAGE_ROW_ID, attachmentId: "someone-elses" } }),
    ).rejects.toThrow(/does not belong/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
