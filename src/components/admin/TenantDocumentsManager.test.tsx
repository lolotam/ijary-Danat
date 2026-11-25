/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك مدير وثائق المستأجر قبل تقسيمه: الرفع، التعديل، الحذف، ورسائل الأخطاء.
 *
 * Audit M28 / plan row 6.12. The manager is 680 lines — upload row, two
 * views, an edit dialog, delete, preview and share — used by four screens.
 * Nothing rendered it under test. These cases pin what a split could break:
 * an upload carries the chosen type, the trimmed display name and the
 * contract scope; an edit that picks no new file saves in "keep" mode; a
 * delete asks first; and a too-large file is explained with the size limit
 * rather than a raw error code.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  doc: {
    id: "doc-1",
    tenant_id: "tenant-1",
    display_name: "Civil ID front",
    type: "civil_id",
    storage_path: "tenant-1/civil.pdf",
    mime_type: "application/pdf",
    size_bytes: 2048,
  },
}));

vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/useTenants", () => ({
  createTenantDocumentSignedUrl: vi.fn(),
  TENANT_DOCUMENT_MAX_MB: 10,
  TENANT_DOCUMENT_TOO_LARGE: "TENANT_DOCUMENT_TOO_LARGE",
  TENANT_DOCUMENT_UNSUPPORTED_TYPE: "TENANT_DOCUMENT_UNSUPPORTED_TYPE",
  useTenantDocuments: () => ({ data: [mocks.doc], isLoading: false, error: null }),
  useUploadTenantDocument: () => ({ mutateAsync: mocks.upload, isPending: false }),
  useUpdateTenantDocument: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteTenantDocument: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));
vi.mock("@/components/admin/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: () => null,
}));
vi.mock("@/components/admin/TenantDocumentShareDialogs", () => ({
  TenantDocumentsBulkBar: () => null,
  TenantDocumentShareDialogs: () => null,
  useShareDialogState: () => ({ shareBusy: false, openShare: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

const { TenantDocumentsManager } = await import("@/components/admin/TenantDocumentsManager");

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب المدير لعقد واحد داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <TenantDocumentsManager tenantId="tenant-1" companyId="company-1" contractId="contract-1" />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** يضع قيمة في حقل تحكمه React ويطلق حدث الإدخال. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** يختار ملفاً في حقل رفع ويطلق حدث التغيير. */
async function pickFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
}

/** آخر زر يحمل النص المطلوب. */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  );
  if (!matches.length) throw new Error(`No button "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.upload.mockReset().mockResolvedValue({});
  mocks.update.mockReset().mockResolvedValue({});
  mocks.remove.mockReset().mockResolvedValue({});
  mocks.toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("tenant documents manager", () => {
  it("uploads with the chosen type, the trimmed name and the contract scope", async () => {
    mount();
    await settle();

    typeInto(container.querySelector("#tenant-doc-name-tenant-1") as HTMLInputElement, "  Lease  ");
    const file = new File(["x"], "lease.pdf", { type: "application/pdf" });
    await pickFile(container.querySelector("#tenant-doc-file-tenant-1") as HTMLInputElement, file);

    expect(mocks.upload).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      companyId: "company-1",
      file,
      type: "civil_id",
      displayName: "Lease",
      contractId: "contract-1",
    });
  });

  it("explains a too-large file with the size limit, not the raw code", async () => {
    mocks.upload.mockRejectedValue(new Error("TENANT_DOCUMENT_TOO_LARGE"));
    mount();
    await settle();

    const file = new File(["x"], "huge.pdf", { type: "application/pdf" });
    await pickFile(container.querySelector("#tenant-doc-file-tenant-1") as HTMLInputElement, file);

    expect(mocks.toastError).toHaveBeenCalledWith(en["documents.uploadError"], {
      description: en["documents.tooLarge"].replace("{{size}}", "10"),
    });
  });

  it("an edit without a new file saves in keep mode with the new name", async () => {
    mount();
    await settle();

    await act(async () => lastButton(en["documents.edit"]).click());
    await settle();
    typeInto(document.querySelector("#doc-edit-name") as HTMLInputElement, "Civil ID back");
    await act(async () => lastButton(en["common.save"]).click());
    await settle();

    expect(mocks.update).toHaveBeenCalledWith({
      mode: "keep",
      id: "doc-1",
      displayName: "Civil ID back",
      type: "civil_id",
    });
  });

  it("deletes only after confirmation", async () => {
    mount();
    await settle();

    await act(async () =>
      (container.querySelector(`[aria-label="${en["common.delete"]}"]`) as HTMLElement).click(),
    );
    await settle();
    expect(mocks.remove).not.toHaveBeenCalled();

    await act(async () => lastButton(en["common.confirm"]).click());
    await settle();

    expect(mocks.remove).toHaveBeenCalledWith(mocks.doc);
  });
});
