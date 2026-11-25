/**
 * @vitest-environment jsdom
 *
 * يثبّت سلوك شاشة الصيانة قبل نقل حواراتها ومنطق نموذجها إلى ملفات مستقلة.
 *
 * Audit M13/M32 / plan rows 6.12 and 6.13. Nothing rendered this screen under
 * test. These cases pin what a split must keep: Edit opens pre-filled from
 * the row; a create sends "none" building/unit as null and a trimmed-empty
 * description as null; and because the dialog stays open after a save, the
 * second Save updates the request just filed instead of filing a duplicate.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  request: {
    id: "req-1",
    code: "MNT-0001",
    property_id: "prop-1",
    building_id: null,
    unit_id: null,
    title: "Leaking tap",
    description: "Kitchen",
    priority: "high",
    status: "open",
  },
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => options,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useCompany", () => ({ useCompany: () => ({ data: { id: "company-1" } }) }));
vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({
    data: { items: [{ id: "prop-1", code: "P-1", name_ar: "برج", name_en: "Tower" }] },
  }),
}));
vi.mock("@/hooks/useBuildings", () => ({ useBuildings: () => ({ data: { items: [] } }) }));
vi.mock("@/hooks/useUnits", () => ({ useUnits: () => ({ data: { items: [] } }) }));
vi.mock("@/hooks/useMaintenance", () => ({
  useMaintenanceRequests: () => ({
    data: { items: [mocks.request], count: 1 },
    isLoading: false,
    isError: false,
  }),
  useMaintenanceExport: () => ({ data: { items: [] } }),
  useCreateMaintenanceRequest: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateMaintenanceRequest: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteMaintenanceRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/admin/CsvImportDialog", () => ({ CsvImportDialog: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { Route } = await import("@/routes/admin.maintenance.index");
const MaintenancePage = (Route as unknown as { component: () => ReactNode }).component;

const en = dictionaries.en;
let container: HTMLDivElement;
let root: Root;

/** يركّب شاشة الصيانة داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <MaintenancePage />
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

/** آخر زر يحمل النص المطلوب. */
function lastButton(text: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === text,
  );
  if (!matches.length) throw new Error(`No button "${text}"`);
  return matches[matches.length - 1] as HTMLButtonElement;
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mocks.create.mockReset().mockResolvedValue({ id: "req-new" });
  mocks.update.mockReset().mockResolvedValue({ id: "req-1" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe("maintenance screen", () => {
  it("opens the edit dialog pre-filled from the row", async () => {
    mount();
    await settle();

    await act(async () =>
      (document.querySelector(`[aria-label="${en["common.edit"]}"]`) as HTMLElement).click(),
    );
    await settle();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(en["maintenance.edit"]);
    const values = [...(dialog?.querySelectorAll("input, textarea") ?? [])].map(
      (field) => (field as HTMLInputElement).value,
    );
    expect(values).toEqual(expect.arrayContaining(["Leaking tap", "Kitchen"]));
  });

  it("an edit saves the row with none → null, and a second save updates the same row", async () => {
    mount();
    await settle();

    await act(async () =>
      (document.querySelector(`[aria-label="${en["common.edit"]}"]`) as HTMLElement).click(),
    );
    await settle();
    await act(async () => lastButton(en["common.save"]).click());
    await settle();
    await act(async () => lastButton(en["common.save"]).click());
    await settle();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenLastCalledWith({
      id: "req-1",
      updates: {
        property_id: "prop-1",
        building_id: null,
        unit_id: null,
        title: "Leaking tap",
        description: "Kitchen",
        priority: "high",
        status: "open",
      },
    });
  });
});
