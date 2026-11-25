import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/usePortalData", () => ({
  usePortalContracts: vi.fn(),
}));

vi.mock("@/hooks/usePortalContractSelection", () => ({
  usePortalContractSelection: vi.fn(() => ({
    contractId: "c1",
    setContractId: vi.fn(),
  })),
}));

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({
    locale: "en" as const,
    dir: "rtl" as const,
    t: (key: string) => key,
  }),
}));

import { usePortalContractSelection } from "@/hooks/usePortalContractSelection";
import { usePortalContracts } from "@/hooks/usePortalData";
import { ContractSwitcher } from "@/components/portal/ContractSwitcher";

const twoContracts = [
  {
    id: "c1",
    code: "CON-00005",
    type: "lease" as const,
    state: "active" as const,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    monthly_amount: 300,
  },
  {
    id: "c2",
    code: "CON-00004",
    type: "lease" as const,
    state: "expired" as const,
    start_date: "2025-02-01",
    end_date: "2025-12-31",
    monthly_amount: 400,
  },
];

/** يثبّت قائمة العقود التي يقرأها المكوّن في اختبار واحد. */
function mockContracts(data: typeof twoContracts | []) {
  vi.mocked(usePortalContracts).mockReturnValue({
    data,
    isLoading: false,
  } as unknown as ReturnType<typeof usePortalContracts>);
}

const source = readFileSync(
  join(process.cwd(), "src/components/portal/ContractSwitcher.tsx"),
  "utf8",
);

describe("ContractSwitcher", () => {
  it("shows the selected contract as position, code and status", () => {
    mockContracts(twoContracts);

    const markup = renderToStaticMarkup(<ContractSwitcher tenantId="t1" />);
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("1-CON-00005 (portal.contract.status.active)");
    expect(markup).toContain('aria-label="portal.contract.select"');
  });

  it("numbers by position in the list, not by the contract's own code", () => {
    // The second contract is CON-00004 and must read "2-", so the number is the
    // row's place in the list rather than anything parsed out of the code.
    mockContracts(twoContracts);
    vi.mocked(usePortalContractSelection).mockReturnValueOnce({
      contractId: "c2",
      setContractId: vi.fn(),
    });

    const markup = renderToStaticMarkup(<ContractSwitcher tenantId="t1" />);
    expect(markup).toContain("2-CON-00004 (portal.contract.status.inactive)");
  });

  it("offers no all-contracts entry", () => {
    // The option was removed on purpose: every portal page now reads as exactly
    // one lease. A merged view returning here would silently un-scope payments.
    mockContracts(twoContracts);

    expect(renderToStaticMarkup(<ContractSwitcher tenantId="t1" />)).not.toContain(
      "portal.contract.all",
    );
    expect(source).not.toMatch(/portal\.contract\.all/);
    expect(source).not.toMatch(/value="all"/);
  });

  it("renders nothing when the tenant has zero contracts", () => {
    mockContracts([]);

    expect(renderToStaticMarkup(<ContractSwitcher tenantId="t1" />)).toBe("");
  });

  it("still renders when the tenant has exactly one contract", () => {
    mockContracts([twoContracts[0]]);

    const markup = renderToStaticMarkup(<ContractSwitcher tenantId="t1" />);
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toBe("");
  });

  it("stamps the locale direction onto the trigger", () => {
    // Reported 2026-08-12: on the Arabic portal the label "العقد:" rendered
    // leftmost, with the contract code and status to its right.
    //
    // Radix resolves direction through useDirection(dir), which falls back to
    // the literal "ltr" with no dir prop and no DirectionProvider, then writes
    // it onto the trigger button (react-select/dist/index.mjs:178). An explicit
    // dir="ltr" attribute beats the rtl inherited from <html>, so the trigger's
    // flex row ran left-to-right. Same defect components/ui/tabs.tsx documents.
    mockContracts(twoContracts);

    expect(renderToStaticMarkup(<ContractSwitcher tenantId="t1" />)).toContain('dir="rtl"');
  });

  it("truncates long labels so a 360px viewport cannot overflow", () => {
    expect(source).toMatch(/min-w-0/);
    expect(source).toMatch(/truncate/);
  });
});
