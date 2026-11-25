/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, expect, it } from "vitest";
import { ContractBuilderForm } from "./ContractBuilderForm";
import { FIXTURE_PLOT, validContractValues } from "@/lib/contractBuilder/schema.fixture";
import type { ContractBuilderValues } from "@/lib/contractBuilder/schema";
import type { SelectableUnitRow } from "@/lib/contractBuilder/units";
import { t } from "@/i18n/dictionary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let form: UseFormReturn<ContractBuilderValues>;

/** وحدات قسيمة الاختبار: سبع وحدات عادية ووحدة سطح يجب ألا تظهر. */
const UNITS: SelectableUnitRow[] = [
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `unit-${index + 1}`,
    code: `U-${index + 1}`,
    name: String(index + 1),
    name_en: `Shop ${index + 1}`,
    paci_no: index === 0 ? null : `1000000${index + 1}`,
    floor: "ground",
    type: "shop_G_Floor",
    property_id: FIXTURE_PLOT.id,
    status: null,
  })),
  {
    id: "roof-1",
    code: "R-1",
    name: "سطح 1",
    name_en: "Roof 1",
    paci_no: null,
    floor: "roof",
    type: "Roof_Apartment",
    property_id: FIXTURE_PLOT.id,
    status: null,
  },
];

/** يركب نموذجاً حقيقياً حتى تختبر النقرات حدود المصفوفات وتغيير اللغة والنوع. */
function Harness({ count }: { count: number }) {
  const values = validContractValues({ units: [] });
  values.persons = Array.from({ length: count }, () => ({ ...values.persons[0]! }));
  form = useForm<ContractBuilderValues>({ defaultValues: values });
  return (
    <ContractBuilderForm
      form={form}
      t={(key) => t("en", key)}
      notices={[]}
      locale="en"
      inventory={{
        properties: [{ code: "PROP-001", ...FIXTURE_PLOT }],
        units: UNITS,
        unitsLoading: false,
      }}
    />
  );
}
/** يعزل شجرة DOM لكل سيناريو لتجنب تسرب حالة النموذج. */
async function mount(count: number) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness count={count} />));
}
/** يجد الزر باسمه المرئي لأن التعطيل سلوك مستخدم وليس تنسيق CSS. */
function button(text: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === text)!;
}
/** يعيد مربعات اختيار الوحدات داخل قائمة القسيمة. */
function unitBoxes() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="plot-units"] [role="checkbox"]',
    ),
  ];
}
/** يغيّر قيمة قائمة منسدلة أصلية كما يفعل المستخدم. */
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

it("prevents adding a fourth person and enables adding after removal", async () => {
  await mount(3);
  expect(button("Add person").disabled).toBe(true);
  await act(async () => button("Remove person").click());
  expect(button("Add person").disabled).toBe(false);
  expect(form.getValues("persons")).toHaveLength(2);
});

it("keeps the final person", async () => {
  await mount(1);
  expect(button("Remove person").disabled).toBe(true);
});

it("updates document language from the visible selector", async () => {
  await mount(1);
  await choose(container.querySelector<HTMLSelectElement>('[name="language"]')!, "en");
  expect(form.getValues("language")).toBe("en");
});

it("switching to company shows the company block and switching back restores the persons", async () => {
  await mount(2);
  const mode = container.querySelector<HTMLSelectElement>('[name="second_party_type"]')!;
  await choose(mode, "company");
  expect(container.querySelector('[name="company.company_name"]')).not.toBeNull();
  expect(container.querySelector('[name="company.signatory_civil_id"]')).not.toBeNull();
  expect(container.querySelector('[name="persons.0.full_name"]')).toBeNull();
  await choose(mode, "individual");
  expect(form.getValues("persons")).toHaveLength(2);
  expect(container.querySelector('[name="persons.1.full_name"]')).not.toBeNull();
});

it("renders the contact fields, marked as not printed", async () => {
  await mount(1);
  for (const name of ["contact_mobile", "contact_whatsapp", "contact_email"]) {
    expect(container.querySelector(`[name="${name}"]`)).not.toBeNull();
  }
  expect(container.textContent).toContain(t("en", "contractBuilder.contactNotPrinted"));
});

it("lists the selected plot's units without the roof, each with its PACI number", async () => {
  await mount(1);
  const list = container.querySelector('[data-testid="plot-units"]')!;
  expect(unitBoxes()).toHaveLength(7);
  expect(list.textContent).not.toContain("سطح 1");
  expect(list.textContent).toContain("10000002");
});

it("stops at six units and disables only the unselected boxes", async () => {
  await mount(1);
  for (const box of unitBoxes().slice(0, 6)) await act(async () => box.click());
  expect(form.getValues("units")).toHaveLength(6);
  const boxes = unitBoxes();
  expect(boxes[6]!.disabled).toBe(true);
  expect(boxes[0]!.disabled).toBe(false);
  await act(async () => boxes[0]!.click());
  expect(unitBoxes()[6]!.disabled).toBe(false);
});

it("a selected unit's PACI number starts from the database and can be overridden", async () => {
  await mount(1);
  await act(async () => unitBoxes()[1]!.click());
  const input = container.querySelector<HTMLInputElement>('[name="units.0.paci_no"]')!;
  expect(input.value).toBe("10000002");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "999");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(form.getValues("units.0.paci_no")).toBe("999");
});

it("a selected unit's Arabic and English names are editable form fields", async () => {
  await mount(1);
  await act(async () => unitBoxes()[1]!.click());
  expect(container.querySelector<HTMLInputElement>('[name="units.0.unit_number"]')!.value).toBe(
    "2",
  );
  expect(container.querySelector<HTMLInputElement>('[name="units.0.unit_number_en"]')!.value).toBe(
    "Shop 2",
  );
});

it("an empty unit selection that failed validation says so beside the picker", async () => {
  await mount(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => {
    form.setError("units", { type: "too_small" });
  });
  expect(container.textContent).toContain(t("en", "contractBuilder.unitsRequired"));
});

it("names a selected plot whose snapshot name is too long to validate", async () => {
  await mount(1);
  await act(async () => {
    form.setValue("plots", [{ ...FIXTURE_PLOT, name_en: "x".repeat(49) }]);
  });
  expect(container.textContent).toContain(t("en", "contractBuilder.plotNameTooLong"));
});
