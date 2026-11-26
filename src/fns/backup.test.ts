import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  createBackupSchema,
  deleteBackupSchema,
  downloadBackupSchema,
  createBackup,
  listBackups,
  downloadBackupUrl,
  deleteBackup,
} from "@/fns/backup";
import {
  restoreBackupSchema,
  backupRestorePreflightSchema,
  restoreBackup,
} from "@/fns/restoreBackup";
import { createBackupArchive, deleteBackupRecord } from "@/fns/backupCore";
import { buildArchive, sha256Hex } from "@/lib/backupArchive";

const supabaseAdmin = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  storage: {
    from: vi.fn(),
  },
}));

vi.mock("@tanstack/react-start", () => {
  // A FRESH object per createServerFn() call. `mockReturnValue(fn)` evaluates
  // `fn` once and hands the same object to every call, so each module's
  // `.handler()` overwrites the shared `_handler` and all six server functions
  // collapse into one reference — pointing at whichever module happened to load
  // last. Tests then appear to cover five functions while exercising one.
  // Matches the pattern in closeoutServerFns.test.ts.
  function makeFn() {
    const fn: any = (data: any) => {
      return fn._handler({ data, context: fn._context });
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((h: any) => {
      fn._handler = h;
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
});

vi.mock("@/fns/backupCore", () => ({
  createBackupArchive: vi.fn(),
  deleteBackupRecord: vi.fn(),
  listBackupRecords: vi.fn(),
  BACKUP_BUCKET: "backups",
  BACKUP_RETENTION_KEEP: 10,
  BACKUP_RETENTION_KEEP_PRE_RESTORE: 5,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => supabaseAdmin,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

describe("backup.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every supabase-js call resolves to { data, error }; a bare vi.fn() returns
    // undefined and the production code's destructuring throws a TypeError that
    // masks whatever the test was actually asserting. Default it, and let
    // individual tests override.
    (supabaseAdmin.rpc as any).mockResolvedValue({ data: null, error: null });
  });

  test("exported Zod schemas: valid parses; a bad uuid and a wrong confirm literal fail", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(createBackupSchema.parse({ note: "test" })).toEqual({ note: "test" });
    expect(deleteBackupSchema.parse({ id: validUuid })).toEqual({ id: validUuid });
    expect(downloadBackupSchema.parse({ id: validUuid })).toEqual({ id: validUuid });
    expect(restoreBackupSchema.parse({ id: validUuid, confirm: "RESTORE" })).toEqual({
      id: validUuid,
      confirm: "RESTORE",
    });
    expect(backupRestorePreflightSchema.parse({ id: validUuid })).toEqual({ id: validUuid });

    expect(() => deleteBackupSchema.parse({ id: "bad" })).toThrow();
    expect(() => restoreBackupSchema.parse({ id: validUuid, confirm: "YES" })).toThrow();
  });

  const mockContext = (isAdmin: boolean) => ({
    userId: "user-1",
    supabase: {
      rpc: vi.fn().mockResolvedValue({ data: isAdmin, error: null }),
    },
  });

  test("a non-admin caller is refused, and the refusal is OBSERVABLE", async () => {
    const createFn = createBackup as any;
    createFn._context = mockContext(false);
    await expect(createFn({ note: "hi" })).rejects.toThrow("Forbidden");

    const listFn = listBackups as any;
    listFn._context = mockContext(false);
    await expect(listFn(undefined)).rejects.toThrow("Forbidden");

    const downloadFn = downloadBackupUrl as any;
    downloadFn._context = mockContext(false);
    await expect(downloadFn({ id: "123e4567-e89b-12d3-a456-426614174000" })).rejects.toThrow(
      "Forbidden",
    );

    const deleteFn = deleteBackup as any;
    deleteFn._context = mockContext(false);
    await expect(deleteFn({ id: "123e4567-e89b-12d3-a456-426614174000" })).rejects.toThrow(
      "Forbidden",
    );

    const restoreFn = restoreBackup as any;
    restoreFn._context = mockContext(false);
    await expect(
      restoreFn({ id: "123e4567-e89b-12d3-a456-426614174000", confirm: "RESTORE" }),
    ).rejects.toThrow("Forbidden");
  });

  test("create/list/download/delete gate on settings.backup", async () => {
    const context = mockContext(false);
    const listFn = listBackups as any;
    listFn._context = context;
    await expect(listFn(undefined)).rejects.toThrow("Forbidden");

    expect(context.supabase.rpc).toHaveBeenCalledWith("has_permission", {
      _code: "settings.backup",
      _user_id: "user-1",
    });
  });

  test("restore stays admin-only even for a holder of settings.backup", async () => {
    // A restore rewrites user_roles and role_permissions, so granting it with
    // the backup permission would let that role make itself admin.
    const rpc = vi
      .fn()
      .mockImplementation((name: string) =>
        Promise.resolve({ data: name === "has_permission", error: null }),
      );
    const restoreFn = restoreBackup as any;
    restoreFn._context = { userId: "user-1", supabase: { rpc } };

    await expect(
      restoreFn({ id: "123e4567-e89b-12d3-a456-426614174000", confirm: "RESTORE" }),
    ).rejects.toThrow("Forbidden");
    expect(rpc).toHaveBeenCalledWith("has_role", { _role: "admin", _user_id: "user-1" });
  });

  test("Restore aborts when sha256 does not match", async () => {
    const { bytes } = buildArchive([], {
      kind: "manual",
      createdAt: new Date(),
      schemaFingerprint: "x",
    });

    (supabaseAdmin.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { storage_path: "p.zip", sha256: "wrong-hash" },
            error: null,
          }),
        }),
      }),
    });

    (supabaseAdmin.storage.from as any).mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: new Blob([new Uint8Array(bytes)]),
        error: null,
      }),
    });

    const restoreFn = restoreBackup as any;
    restoreFn._context = mockContext(true);

    await expect(
      restoreFn({ id: "123e4567-e89b-12d3-a456-426614174000", confirm: "RESTORE" }),
    ).rejects.toThrow();

    expect(supabaseAdmin.rpc).not.toHaveBeenCalledWith("backup_restore", expect.any(Object));
  });

  test("Restore aborts when safety archive fails", async () => {
    const { bytes } = buildArchive([], {
      kind: "manual",
      createdAt: new Date(),
      schemaFingerprint: "x",
    });

    const realHash = await sha256Hex(bytes);

    (supabaseAdmin.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { storage_path: "p.zip", sha256: realHash },
            error: null,
          }),
        }),
      }),
    });

    (supabaseAdmin.storage.from as any).mockReturnValue({
      download: vi.fn().mockResolvedValue({
        data: new Blob([new Uint8Array(bytes)]),
        error: null,
      }),
    });

    // Mock createBackupArchive to fail
    (createBackupArchive as any).mockRejectedValue(new Error("Insert failed"));

    const restoreFn = restoreBackup as any;
    restoreFn._context = mockContext(true);

    await expect(
      restoreFn({ id: "123e4567-e89b-12d3-a456-426614174000", confirm: "RESTORE" }),
    ).rejects.toThrow("Aborted: Could not create safety backup");

    expect(supabaseAdmin.rpc).not.toHaveBeenCalledWith("backup_restore", expect.any(Object));
  });
});
