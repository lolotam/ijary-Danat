import { describe, test, expect, vi, beforeEach } from "vitest";
import { createBackupArchive, deleteBackupRecord, BACKUP_BUCKET } from "@/fns/backupCore";
import { serverCompanyClient } from "@/company/companyClient.server";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

// Mock the companyClient boundary
vi.mock("@/company/companyClient.server", () => {
  const fromMock = vi.fn().mockReturnThis();
  const selectMock = vi.fn().mockReturnThis();
  const eqMock = vi.fn().mockReturnThis();
  const singleMock = vi.fn().mockReturnThis();
  const maybeSingleMock = vi.fn().mockReturnThis();
  const insertMock = vi.fn().mockReturnThis();
  const deleteMock = vi.fn().mockReturnThis();

  const mockClient = {
    from: fromMock,
    select: selectMock,
    eq: eqMock,
    single: singleMock,
    maybeSingle: maybeSingleMock,
    insert: insertMock,
    delete: deleteMock,
    rpc: vi.fn(),
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn(),
        remove: vi.fn(),
      }),
    },
  };

  return {
    serverCompanyClient: () => ({
      companyId: COMPANY_ID,
      client: mockClient,
    }),
  };
});

const supabaseAdmin = serverCompanyClient().client;

describe("backupCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("Retention deletes the row BEFORE the object", async () => {
    // Setup fetch to succeed
    (supabaseAdmin.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { storage_path: "backups/test.zip", file_name: "test.zip" },
            error: null,
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    });

    const removeStorageMock = vi.fn().mockResolvedValue({ error: null });
    (supabaseAdmin.storage.from as any).mockReturnValue({ remove: removeStorageMock });
    (supabaseAdmin.rpc as any).mockResolvedValue({ data: null, error: null });

    const callOrder: string[] = [];

    // Intercept to capture call order
    (supabaseAdmin.from as any).mockReturnValue({
      select: (supabaseAdmin.from as any)().select,
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(async () => {
          callOrder.push("row_delete");
          return { error: null };
        }),
      }),
    });

    (supabaseAdmin.storage.from as any).mockReturnValue({
      remove: vi.fn().mockImplementation(async () => {
        callOrder.push("object_delete");
        return { error: null };
      }),
    });

    await deleteBackupRecord("uuid");

    expect(callOrder).toEqual(["row_delete", "object_delete"]);
  });

  test("A pre_restore archive is not pruned by the ordinary allowance", async () => {
    // Seed 12 manual archives and 2 pre_restore archives
    const mockBackups = Array.from({ length: 14 }).map((_, i) => ({
      id: `id-${i}`,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      kind: i < 12 ? "manual" : "pre_restore",
      storage_path: `backups/${i}.zip`,
    }));

    (supabaseAdmin.rpc as any).mockImplementation(async (rpcName: string) => {
      if (rpcName === "backup_dump_all") {
        return {
          data: {
            format_version: 1,
            schema_fingerprint: "abc",
            tables: [{ name: "users", rows: [] }],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    (supabaseAdmin.storage.from as any).mockReturnValue({
      upload: vi.fn().mockResolvedValue({ error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    const deletedIds: string[] = [];
    (supabaseAdmin.from as any).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "new" }, error: null }),
        }),
      }),
      select: vi.fn().mockImplementation((col) => {
        if (col === "storage_path, file_name") {
          return {
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { storage_path: "p", file_name: "f" } }),
            }),
          };
        }
        return Promise.resolve({ data: mockBackups, error: null });
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation((col: string, val: string) => {
          deletedIds.push(val);
          return Promise.resolve({ error: null });
        }),
      }),
    });

    await createBackupArchive({ kind: "manual", createdBy: null, prune: true });

    // With 12 manual backups and limit 10, the oldest 2 manuals should be deleted
    // pre_restore limit is 5, we have 2, so none should be deleted
    expect(deletedIds.length).toBeGreaterThan(0);
    const deletedManuals = mockBackups
      .filter((b) => deletedIds.includes(b.id))
      .every((b) => b.kind !== "pre_restore");
    expect(deletedManuals).toBe(true);
  });

  test("Upload succeeds, metadata insert fails => row confirmed absent => object deleted", async () => {
    (supabaseAdmin.rpc as any).mockImplementation(async (rpcName: string) => {
      if (rpcName === "backup_dump_all") {
        return {
          data: {
            format_version: 1,
            schema_fingerprint: "abc",
            tables: [{ name: "users", rows: [] }],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    let uploadedPath = "";
    (supabaseAdmin.storage.from as any).mockReturnValue({
      upload: vi.fn().mockImplementation(async (path: string) => {
        uploadedPath = path;
        return { error: null };
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    (supabaseAdmin.from as any).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: "Insert DB fail" } }),
        }),
      }),
      // Mock the new requery behavior: row absent
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }), // Row absent
        }),
      }),
    });

    await expect(
      createBackupArchive({ kind: "manual", createdBy: null, prune: false }),
    ).rejects.toThrow("Insert DB fail");

    const removeStorageMock = (supabaseAdmin.storage.from as any)().remove;
    expect(removeStorageMock).toHaveBeenCalledWith([uploadedPath]);
  });

  test("Upload succeeds, metadata insert fails => row found to exist => object KEPT", async () => {
    (supabaseAdmin.rpc as any).mockImplementation(async (rpcName: string) => {
      if (rpcName === "backup_dump_all") {
        return {
          data: {
            format_version: 1,
            schema_fingerprint: "abc",
            tables: [{ name: "users", rows: [] }],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    let uploadedPath = "";
    (supabaseAdmin.storage.from as any).mockReturnValue({
      upload: vi.fn().mockImplementation(async (path: string) => {
        uploadedPath = path;
        return { error: null };
      }),
      remove: vi.fn().mockResolvedValue({ error: null }),
    });

    (supabaseAdmin.from as any).mockReturnValue({
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: "Insert DB fail - timeout maybe" },
          }),
        }),
      }),
      // Mock the new requery behavior: row exists
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { id: "1" }, error: null }), // Row exists
        }),
      }),
    });

    await expect(
      createBackupArchive({ kind: "manual", createdBy: null, prune: false }),
    ).rejects.toThrow("Insert DB fail");

    // Because row exists, object should NOT be removed
    const removeStorageMock = (supabaseAdmin.storage.from as any)().remove;
    expect(removeStorageMock).not.toHaveBeenCalled();
  });
});
