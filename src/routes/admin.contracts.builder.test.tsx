/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n/provider";
import { renderToStaticMarkup } from "react-dom/server";
import { useForm } from "react-hook-form";
import { afterEach, expect, it, vi } from "vitest";
import { ContractBuilderForm } from "@/components/admin/contracts/ContractBuilderForm";
import { contractBuilderDefaults } from "@/lib/contractBuilder/schema";
import { t } from "@/i18n/dictionary";

// حدود TanStack والخادم فقط: لا نحاكي منطق العقد أو مخططه.
vi.mock("@tanstack/react-start", () => {
  const chain = {
    middleware: () => chain,
    inputValidator: () => chain,
    validator: () => chain,
    handler: () => vi.fn(),
    server: () => chain,
  };
  return { createServerFn: () => chain, createMiddleware: () => chain };
});
const boundary = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: boundary }));
import { ContractBuilderEditor, validateBuilderSearch } from "./admin.contracts_.builder";

it.each([
  ["not-a-uuid", {}],
  ["10000000-0000-4000-8000-000000000001", { contract: "10000000-0000-4000-8000-000000000001" }],
])("filters prefill search %s", (contract, expected) => {
  expect(validateBuilderSearch({ contract })).toEqual(expected);
});
/** يستخدم النموذج الحقيقي لإثبات ظهور تحذيرات التعبئة للمستخدم. */
function NoticesHarness() {
  const form = useForm({ defaultValues: contractBuilderDefaults });
  return (
    <ContractBuilderForm
      form={form}
      t={(key) => t("en", key)}
      notices={["multi_property", "increase_fixed_not_supported"]}
      locale="en"
      inventory={{ properties: [], units: [], unitsLoading: false }}
    />
  );
}
it("shows both prefill notices as list items above the fields", () => {
  const markup = renderToStaticMarkup(<NoticesHarness />);
  expect(markup).toContain('data-testid="prefill-notices"');
  expect(markup).toContain(
    "<li>The contract spans more than one property; fill the property fields by hand</li>",
  );
  expect(markup).toContain(
    "<li>A fixed-amount rent increase is not supported by the contract text; enter a percentage by hand</li>",
  );
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  queryClient?.clear();
  vi.unstubAllGlobals();
});

/** يترك الوحدات معلقة ليثبت أن اكتمال العقد والمستأجر وحدهما لا يعيدان ضبط النموذج. */
it("waits for all prefill reads and preserves edits through a background refetch", async () => {
  let resolveUnits!: (value: { data: never[]; error: null }) => void;
  const unitsRead = new Promise<{ data: never[]; error: null }>((resolve) => {
    resolveUnits = resolve;
  });
  const contractId = "10000000-0000-4000-8000-000000000001";
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["contract", contractId], {
    id: contractId,
    tenant_id: "tenant-1",
    start_date: "2026-09-15",
    monthly_amount: 1250,
    duration_months: 12,
    increase_type: "fixed",
  });
  queryClient.setQueryData(["tenant", "tenant-1"], {
    id: "tenant-1",
    name: "Original owner",
    owner_name: "Original owner",
    commercial_name: "Original shop",
  });
  boundary.from.mockImplementation(() => {
    // `in`/`range` serve the builder's property and plot-unit reads, which
    // resolve empty so no error banner stands in for a missing mock method.
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      range: () => Promise.resolve({ data: [], count: 0, error: null }),
      order: () => unitsRead,
    };
    return query;
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <I18nProvider>
          <ContractBuilderEditor contractId={contractId} />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  expect(container.querySelector<HTMLInputElement>('[name="persons.0.full_name"]')!.value).toBe("");
  await act(async () => {
    resolveUnits({ data: [], error: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await vi.waitFor(() =>
    expect(container!.querySelector<HTMLInputElement>('[name="persons.0.full_name"]')!.value).toBe(
      "Original owner",
    ),
  );
  expect(container.querySelector('[data-testid="prefill-notices"]')!.textContent).toContain(
    "زيادة الإيجار",
  );
  const nameInput = container.querySelector<HTMLInputElement>('[name="persons.0.full_name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameInput,
      "Edited owner",
    );
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    queryClient!.setQueryData(["tenant", "tenant-1"], {
      id: "tenant-1",
      name: "Refetched owner",
      commercial_name: "Updated shop",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(nameInput.value).toBe("Edited owner");
});

/** يثبت أن تبديل اللغة يحدّث الاسم التجاري المعبأ تلقائياً دون المساس بتعديل المستخدم. */
it("follows the language switch for the trade name, but never overwrites an edit", async () => {
  const contractId = "10000000-0000-4000-8000-000000000002";
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["contract", contractId], {
    id: contractId,
    tenant_id: "tenant-2",
    start_date: "2026-09-15",
    monthly_amount: 1250,
    duration_months: 12,
  });
  queryClient.setQueryData(["tenant", "tenant-2"], {
    id: "tenant-2",
    name: "مؤسسة اجمل اختيار",
    commercial_name_ar: "اجمل اختيار",
    commercial_name_en: "Ajmal Ekhtiar",
    commercial_name: "Ajmal",
  });
  boundary.from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => Promise.resolve({ data: [], error: null }),
    };
    return query;
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <I18nProvider>
          <ContractBuilderEditor contractId={contractId} />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  );
  const tradeInput = () => container!.querySelector<HTMLInputElement>('[name="trade_name"]')!;
  await vi.waitFor(() => expect(tradeInput().value).toBe("اجمل اختيار"));

  const languageSelect = container.querySelector<HTMLSelectElement>('[name="language"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      languageSelect,
      "en",
    );
    languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(tradeInput().value).toBe("Ajmal Ekhtiar");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      tradeInput(),
      "Typed by the operator",
    );
    tradeInput().dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      languageSelect,
      "ar",
    );
    languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(tradeInput().value).toBe("Typed by the operator");
});
