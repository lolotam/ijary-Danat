/**
 * @vitest-environment jsdom
 *
 * The increase section is the form surface of migration 196: a switch that
 * emits the default trio, and a locked mode that renders read-only with the
 * lock note. The disabled attribute is asserted directly — shadcn inputs bake
 * `disabled:*` classes into every render, so a class match proves nothing.
 *
 * Same jsdom + createRoot technique as AuthProvider.test.tsx — this repo has
 * no @testing-library; one Radix switch click is all that is needed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ContractIncreaseSection } from "@/components/admin/contracts/ContractIncreaseSection";
import type { ContractIncreaseValue } from "@/components/admin/contracts/ContractIncreaseSection";

// No @testing-library here: React's act() needs this flag to know it runs in
// a test environment, otherwise every call logs a warning (harmless but noisy).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels = {
  title: "Rent increase",
  enable: "Apply an increase",
  afterYears: "After year",
  type: "Type",
  percent: "Percent",
  fixed: "Fixed",
  value: "Value",
  locked: "Locked: an invoice after the effective period is paid",
  effectiveFrom: "Effective from",
};

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * يركّب قسم الزيادة في جذر React حي.
 */
function mountSection(props: {
  value: ContractIncreaseValue | null;
  locked: boolean;
  onChange?: (value: ContractIncreaseValue | null) => void;
}): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ContractIncreaseSection
        value={props.value}
        onChange={props.onChange ?? vi.fn()}
        locked={props.locked}
        startDate="2025-02-01"
        labels={labels}
        locale="en"
      />,
    );
  });
  roots.push({ root, container });
  return container;
}

/**
 * يقرأ حقل القيمة عبر aria-label — وهو ما يحلّله getByLabelText هنا.
 */
function valueInput(container: HTMLDivElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Value"]');
  expect(input, "the value input should render").toBeTruthy();
  return input!;
}

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.clearAllMocks();
});

describe("ContractIncreaseSection", () => {
  test("renders read-only with the lock note when locked", () => {
    const container = mountSection({
      value: { after_years: 1, type: "percent", value: 10 },
      locked: true,
    });
    expect(container.textContent).toMatch(/Locked:/);
    expect(valueInput(container).getAttribute("disabled")).toBe("");
    expect(container.textContent).toMatch(/Effective from 2026-02/);
  });

  test("toggling on emits a default trio", async () => {
    const onChange = vi.fn();
    const container = mountSection({ value: null, locked: false, onChange });

    const switchButton = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(switchButton, "the enable switch should render").toBeTruthy();
    await act(async () => {
      switchButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ after_years: 1, type: "percent", value: 0 });
  });

  test("toggling off emits null", async () => {
    const onChange = vi.fn();
    const container = mountSection({
      value: { after_years: 1, type: "percent", value: 10 },
      locked: false,
      onChange,
    });

    const switchButton = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    await act(async () => {
      switchButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
