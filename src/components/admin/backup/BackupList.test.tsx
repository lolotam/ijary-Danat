/**
 * @vitest-environment jsdom
 *
 * يختبر سلوك بطاقة أرشيف النسخ الاحتياطية: الحالة الفارغة، عرض الصفوف،
 * تمييز الإجراءات الخطيرة عن الآمنة، وتوفر أزرار الحذف والاستعادة.
 *
 * Uses the same rendering pattern as admin.settings.cards.test.tsx — real
 * React DOM via createRoot so button clicks fire real events, and mocks kept
 * minimal so the test reflects actual component behaviour rather than mocked
 * implementation details.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries } from "@/i18n/dictionary";
import type { BackupRecord } from "@/hooks/useBackups";
import { I18nProvider } from "@/i18n/provider";

// ────────────────────────────────────────────────────────────────────────────
// Hoisted mocks
// ────────────────────────────────────────────────────────────────────────────

const { deleteMutate, downloadMutate } = vi.hoisted(() => ({
  deleteMutate: vi.fn(),
  downloadMutate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => opts,
}));

vi.mock("@/hooks/useBackups", async (importOriginal) => {
  // Keep the real formatBytes — tests assert on formatted size strings.
  const real = await importOriginal<typeof import("@/hooks/useBackups")>();
  return {
    ...real,
    useDeleteBackup: () => ({ mutateAsync: deleteMutate, isPending: false }),
    useDownloadBackup: () => ({ mutateAsync: downloadMutate, isPending: false }),
    useRestoreBackup: () => ({ mutateAsync: vi.fn(), isPending: false }),
    // RestoreDialog now runs the preflight when it opens. Stubbed here because
    // this file is testing the LIST, and the real hook would need a
    // QueryClientProvider that says nothing about the behaviour under test.
    // RestoreDialog's own coverage exercises the preflight properly.
    useRestorePreflight: () => ({
      data: {
        ok: true as const,
        manifest: {
          file_name: "backup-2026-08-17-0312.zip",
          created_at: "2026-08-17T00:12:00.000Z",
          table_count: 40,
          row_count: 2130,
          size_bytes: 42_500,
        },
        orphan_logins: 0,
        restorable: true,
      },
      isLoading: false,
      isPending: false,
      error: null,
    }),
  };
});

// Mock alert-dialog to plain native elements so click events work in jsdom
// without Radix portal machinery.
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => (asChild ? <>{children}</> : <p>{children}</p>),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <span>{children}</span>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-tooltip>{children}</span>
  ),
}));

// Silence sonner toasts in tests.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BackupList } from "@/components/admin/backup/BackupList";

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const makeBackup = (overrides: Partial<BackupRecord> = {}): BackupRecord => ({
  id: "id-1",
  file_name: "backup-2026-08-17-0312.zip",
  storage_path: "backups/2f1c9a44-0d3e-4c8a-9f27-6f3b8f7f1a02.zip",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  period_key: null,
  size_bytes: 42_500,
  table_count: 12,
  row_count: 3_400,
  kind: "manual",
  note: null,
  created_by: null,
  created_at: new Date().toISOString(),
  ...overrides,
});

// ────────────────────────────────────────────────────────────────────────────
// Mount helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * يركّب مكوّن قائمة النسخ الاحتياطية في شجرة React حية لاختبار السلوك الفعلي.
 */
function mountList(
  backups: BackupRecord[],
  canRestore = true,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <BackupList backups={backups} canRestore={canRestore} />
      </I18nProvider>,
    );
  });
  return { container, root };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("BackupList", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    deleteMutate.mockReset();
    downloadMutate.mockReset();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it("renders the empty state when there are no backups", () => {
    ({ container, root } = mountList([]));
    expect(container.textContent).toContain(dictionaries.ar["settings.backup.list.empty"]);
    // Table must NOT render — no rows to confuse scrapers.
    expect(container.querySelector("[data-testid='backup-table']")).toBeNull();
  });

  // ── Row rendering ──────────────────────────────────────────────────────────

  it("renders a row with formatted size and kind badge", () => {
    const b = makeBackup({ size_bytes: 42_500, kind: "manual" });
    ({ container, root } = mountList([b]));

    expect(container.textContent).toContain("41.5 KB");
    expect(container.textContent).toContain(dictionaries.ar["settings.backup.list.manual"]);
    // Table is rendered when there are backups.
    expect(container.querySelector("[data-testid='backup-table']")).not.toBeNull();
  });

  it("renders the correct badge label for automatic kind", () => {
    const b = makeBackup({ kind: "automatic" });
    ({ container, root } = mountList([b]));
    expect(container.textContent).toContain(dictionaries.ar["settings.backup.list.automatic"]);
  });

  it("renders the correct badge label for pre_restore kind", () => {
    const b = makeBackup({ kind: "pre_restore" });
    ({ container, root } = mountList([b]));
    expect(container.textContent).toContain(dictionaries.ar["settings.backup.list.pre_restore"]);
  });

  // ── Actions reachable and distinct ────────────────────────────────────────

  it("has three distinct action buttons per row", () => {
    const b = makeBackup();
    ({ container, root } = mountList([b]));

    const downloadBtn = container.querySelector(
      `[aria-label="${dictionaries.ar["settings.backup.list.download"]}"]`,
    );
    const restoreBtn = container.querySelector(
      `[aria-label="${dictionaries.ar["settings.backup.list.restore"]}"]`,
    );
    const deleteBtn = container.querySelector(
      `[aria-label="${dictionaries.ar["settings.backup.list.delete"]}"]`,
    );

    expect(downloadBtn).not.toBeNull();
    expect(restoreBtn).not.toBeNull();
    expect(deleteBtn).not.toBeNull();

    // All three must be distinct elements.
    expect(downloadBtn).not.toBe(restoreBtn);
    expect(downloadBtn).not.toBe(deleteBtn);
    expect(restoreBtn).not.toBe(deleteBtn);
  });

  it("hides the restore button from a caller who may not restore", () => {
    // settings.backup opens this page, but restore stays admin-only.
    ({ container, root } = mountList([makeBackup()], false));

    const restoreBtn = container.querySelector(
      `[aria-label="${dictionaries.ar["settings.backup.list.restore"]}"]`,
    );
    const downloadBtn = container.querySelector(
      `[aria-label="${dictionaries.ar["settings.backup.list.download"]}"]`,
    );
    expect(restoreBtn).toBeNull();
    expect(downloadBtn).not.toBeNull();
  });

  it("download button is not disabled when idle", () => {
    ({ container, root } = mountList([makeBackup()]));
    const btn = container.querySelector<HTMLButtonElement>(
      `[aria-label="${dictionaries.ar["settings.backup.list.download"]}"]`,
    );
    expect(btn).not.toBeNull();
    // Assert the actual attribute, not a class — see test brief.
    expect(btn!.hasAttribute("disabled")).toBe(false);
  });

  it("delete button opens a confirmation dialog on click", () => {
    ({ container, root } = mountList([makeBackup()]));

    const deleteBtn = container.querySelector<HTMLButtonElement>(
      `[aria-label="${dictionaries.ar["settings.backup.list.delete"]}"]`,
    );
    expect(deleteBtn).not.toBeNull();

    act(() => {
      deleteBtn!.click();
    });

    // The mocked AlertDialog renders when open=true.
    expect(container.querySelector("[data-testid='alert-dialog']")).not.toBeNull();
  });

  it("restore button opens a confirmation dialog on click", () => {
    ({ container, root } = mountList([makeBackup()]));

    const restoreBtn = container.querySelector<HTMLButtonElement>(
      `[aria-label="${dictionaries.ar["settings.backup.list.restore"]}"]`,
    );
    expect(restoreBtn).not.toBeNull();

    act(() => {
      restoreBtn!.click();
    });

    expect(container.querySelector("[data-testid='alert-dialog']")).not.toBeNull();
  });
});
