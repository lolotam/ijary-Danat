/**
 * @vitest-environment jsdom
 *
 * اسم المستأجر رابط حقيقي إلى صفحته: نقرة واحدة تنقّل مرة واحدة دون المرور
 * بمعالج الصف، والنقر في بقية الصف ما زال يفتح المستأجر.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";
import type { TenantWithActiveLocation } from "@/hooks/useTenants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", async (original) => {
  const actual = await original<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      params,
      to,
      onClick,
      onKeyDown,
      className,
    }: {
      children: ReactNode;
      params?: { id: string };
      to: string;
      onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
      onKeyDown?: (event: React.KeyboardEvent<HTMLAnchorElement>) => void;
      className?: string;
    }) => (
      <a
        href={params ? to.replace("$id", params.id) : to}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={className}
      >
        {children}
      </a>
    ),
  };
});

const { TenantsTable } = await import("@/components/admin/tenants/TenantsTable");

/** مستأجر واحد بأقل الحقول التي يقرأها الجدول في وضع الجدول. */
function tenantRow(): TenantWithActiveLocation {
  return {
    id: "tenant-1",
    code: "TEN-0007",
    name: "Sara Ali",
    name_en: null,
    mobile: null,
    email: null,
    category: "individual",
    lifecycle: "active",
    preferred_language: "ar",
    reminders_enabled: true,
    tenant_portal_enabled: true,
    connectedProperties: [],
    activeContracts: [],
    contractStatuses: [],
    hasOverdue: false,
  } as unknown as TenantWithActiveLocation;
}

const baseProps = {
  loading: false,
  error: false,
  layoutMode: "table",
  cardsPerLine: 3,
  isMobile: false,
  selected: [],
  onSelectedChange: (() => {}) as never,
  sort: { key: "name", direction: "asc" },
  toggle: (() => {}) as never,
  onEdit: (() => {}) as never,
  onDocuments: (() => {}) as never,
  onToggleBlocked: (() => {}) as never,
  onDelete: (() => {}) as never,
  canUpdate: true,
  canDelete: false,
  blockPending: false,
  documentTenantIds: new Set<string>(),
  portalAccountTenantIds: new Set<string>(["tenant-1"]),
  portalAccountsUnknown: false,
} as const;

let container: HTMLDivElement;
let root: Root;

/** يركّب الجدول في وضع الجدول مع معالجَي فتح قابلين للفحص. */
function mountTable(onOpen: (tenant: { id: string }) => void): void {
  const items = [tenantRow()];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <TenantsTable
          {...baseProps}
          selected={[]}
          items={items}
          sortedItems={items}
          onOpen={onOpen}
          onOpenKeyDown={(event, tenant) => {
            if (event.key === "Enter") onOpen(tenant);
          }}
        />
      </I18nProvider>,
    );
  });
}

/** رابط اسم المستأجر في خلية الاسم. */
function nameLink(): HTMLAnchorElement {
  const links = [...container.querySelectorAll("a")] as HTMLAnchorElement[];
  const link = links.find((candidate) => candidate.textContent?.includes("Sara Ali"));
  if (!link) throw new Error("tenant name link not found");
  return link;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TenantsTable tenant name link", () => {
  it("renders the name as a link to the tenant page", () => {
    mountTable(vi.fn());
    // The href is the observable contract: a span styled as a link would pass
    // a text assertion while navigating nowhere.
    expect(nameLink().getAttribute("href")).toBe("/admin/tenants/tenant-1");
  });

  it("clicking the name navigates once without calling the row onOpen", () => {
    const onOpen = vi.fn();
    mountTable(onOpen);
    act(() => {
      nameLink().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // stopRowEvents stops the click at the link; without it the row handler
    // fires too and the app navigates twice.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Enter on the name link does not call the row onOpen", () => {
    const onOpen = vi.fn();
    mountTable(onOpen);
    act(() => {
      nameLink().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking elsewhere in the row still calls onOpen", () => {
    const onOpen = vi.fn();
    mountTable(onOpen);
    const codeCell = [...container.querySelectorAll("td")].find((cell) =>
      cell.textContent?.includes("TEN-0007"),
    );
    if (!codeCell) throw new Error("tenant code cell not found");
    act(() => {
      codeCell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "tenant-1" }));
  });
});
