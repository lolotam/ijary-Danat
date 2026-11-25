import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandContractsField } from "@/components/admin/landing-page/BrandContractsField";
import type { ActiveContractOption } from "@/hooks/useLandingSettings";

vi.mock("@/i18n/provider", () => ({ useI18n: () => ({ locale: "ar", t: (key: string) => key }) }));

const OPTIONS: ActiveContractOption[] = [
  { id: "c-active-1", code: "CON-0001", tenantName: "ألفا", unitName: "U-1" },
  { id: "c-active-2", code: "CON-0002", tenantName: "بيتا", unitName: "U-2" },
];

const LABELS = {
  heading: "العقود",
  empty: "لا عقود",
  selectedCount: (count: number) => `${count} selected`,
  hiddenCount: (count: number) => `${count} hidden`,
};

/** يلتقط المجموعة التي يبثّها الحقل عند تبديل خانة. */
function toggleFirstOption(selectedIds: string[]): string[] {
  let emitted: string[] = [];
  // The component builds the next set from `selectedIds` and `options` alone,
  // so calling its onCheckedChange through a render is unnecessary — invoking
  // the same computation the checkbox does is what is under test here.
  const field = BrandContractsField({
    options: OPTIONS,
    selectedIds,
    onChange: (ids) => {
      emitted = ids;
    },
    labels: LABELS,
  });
  const checkboxes: Array<(checked: boolean) => void> = [];
  JSON.stringify(field, (_key, value) => {
    if (value?.props?.onCheckedChange) checkboxes.push(value.props.onCheckedChange);
    return value;
  });
  checkboxes[0](true);
  return emitted;
}

describe("BrandContractsField", () => {
  /**
   * `useActiveContractOptions` offers ACTIVE contracts only. A shop still
   * linked to an expired or renewed lease therefore has ids with no checkbox,
   * and the saved array is the COMPLETE desired set — so rebuilding it from the
   * options alone drops those links permanently the moment anyone ticks a box.
   * The shops table also omits unlabelled ids, which makes the loss invisible.
   */
  it("carries links to non-active contracts through a toggle", () => {
    const emitted = toggleFirstOption(["c-expired", "c-active-2"]);

    expect(emitted).toContain("c-expired");
    expect(emitted).toContain("c-active-1");
    expect(emitted).toContain("c-active-2");
  });

  it("still removes an offered contract when it is unticked", () => {
    let emitted: string[] = [];
    const field = BrandContractsField({
      options: OPTIONS,
      selectedIds: ["c-active-1", "c-expired"],
      onChange: (ids) => {
        emitted = ids;
      },
      labels: LABELS,
    });
    const handlers: Array<(checked: boolean) => void> = [];
    JSON.stringify(field, (_key, value) => {
      if (value?.props?.onCheckedChange) handlers.push(value.props.onCheckedChange);
      return value;
    });

    handlers[0](false);

    expect(emitted).not.toContain("c-active-1");
    // Unticking one contract must not take the invisible ones with it.
    expect(emitted).toContain("c-expired");
  });

  it("tells the operator when links exist that the list cannot show", () => {
    const markup = renderToStaticMarkup(
      <BrandContractsField
        options={OPTIONS}
        selectedIds={["c-active-1", "c-expired"]}
        onChange={vi.fn()}
        labels={LABELS}
      />,
    );

    expect(markup).toContain("2 selected");
    expect(markup).toContain("1 hidden");
  });

  it("says nothing about hidden links when there are none", () => {
    const markup = renderToStaticMarkup(
      <BrandContractsField
        options={OPTIONS}
        selectedIds={["c-active-1"]}
        onChange={vi.fn()}
        labels={LABELS}
      />,
    );

    expect(markup).toContain("1 selected");
    // `not.toContain("hidden")` would pass for the wrong reason and fail for
    // another one: Radix emits `aria-hidden` on its own inputs. Assert on the
    // label this component actually renders.
    expect(markup).not.toMatch(/\d+ hidden/);
  });
});
