/**
 * @vitest-environment jsdom
 *
 * حوار تفاصيل المستأجر السريع: يعرض الملف الشخصي ويفتح على تبويب الوثائق.
 *
 * Moved verbatim out of `admin.tenants.index.tsx` (plan row 6.12). This pins
 * the two things that screen relies on: the dialog is closed with no tenant
 * and opens titled with the tenant's name, and it opens on the documents tab
 * with the manager scoped to that tenant.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/admin/TenantDocumentsManager", () => ({
  TenantDocumentsManager: ({ tenantId }: { tenantId: string }) => (
    <div data-testid="documents-manager">{tenantId}</div>
  ),
}));

const { TenantDetails } = await import("@/components/admin/tenants/TenantDetailsDialog");

const tenant = {
  id: "tenant-1",
  code: "TEN-0007",
  name: "Sara Ali",
  name_en: null,
  mobile: "+96550000000",
  email: "sara@example.com",
  category: "individual",
  lifecycle: "active",
} as never;

let container: HTMLDivElement;
let root: Root;

/** يركّب الحوار بالمستأجر المعطى. */
function mount(value: typeof tenant | null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <TenantDetails tenant={value} companyId="company-1" close={() => {}} />
      </I18nProvider>,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("tenant details dialog", () => {
  it("renders nothing without a tenant", () => {
    mount(null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens on the documents tab with the manager scoped to that tenant", () => {
    mount(tenant);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("TEN-0007");
    expect(document.querySelector('[data-testid="documents-manager"]')?.textContent).toBe(
      "tenant-1",
    );
  });
});
