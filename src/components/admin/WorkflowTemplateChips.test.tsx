/**
 * @vitest-environment jsdom
 *
 * شرائح قوالب سير العمل: تعرض الرموز المربوطة، والنقر يفتح محرر القالب نفسه.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { WorkflowTemplateChips } = await import("@/components/admin/WorkflowTemplateChips");

type Template = Tables<"notification_templates">;

/** صف قالب بلا حقول زائدة — الشرائح تقرأ id/code فقط عبر onEdit. */
function templateRow(code: string): Template {
  return { id: `template-${code}`, code } as Template;
}

function templatesByCode(codes: string[]): ReadonlyMap<string, Template> {
  return new Map(codes.map((code) => [code, templateRow(code)]));
}

let container: HTMLDivElement;
let root: Root;

/** يركّب الشرائح داخل مزوّد الترجمة. */
function mount(props: {
  workflowKey: string;
  codes: string[];
  onEdit?: (template: Template) => void;
}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <WorkflowTemplateChips
          workflowKey={props.workflowKey}
          templatesByCode={templatesByCode(props.codes)}
          onEdit={props.onEdit}
        />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkflowTemplateChips", () => {
  it("renders one chip per mapped code", () => {
    // invoice-disputed maps to exactly one code; a dropped or doubled mapping
    // would show here before it reaches the workflows table.
    mount({ workflowKey: "invoice-disputed", codes: ["invoice-disputed"], onEdit: vi.fn() });
    expect(container.textContent).toContain("invoice-disputed");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("renders both codes of a two-template workflow", () => {
    // payment-succeeded sends a receipt and an admin alert; rendering only one
    // would hide half the wiring from the admin.
    mount({
      workflowKey: "payment-succeeded",
      codes: ["receipt", "payment-admin-alert"],
      onEdit: vi.fn(),
    });
    expect(container.textContent).toContain("receipt");
    expect(container.textContent).toContain("payment-admin-alert");
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  it("clicking a chip calls onEdit with the matching template row", () => {
    const onEdit = vi.fn();
    mount({
      workflowKey: "payment-succeeded",
      codes: ["receipt", "payment-admin-alert"],
      onEdit,
    });
    const receiptButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("receipt"),
    );
    expect(receiptButton).toBeTruthy();
    act(() => {
      receiptButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The editor must open the clicked template, not the first in the map.
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toMatchObject({ code: "receipt" });
  });

  it("renders a missing template as inert text, not a button", () => {
    // An admin-deleted template falls back to the built-in copy at send time,
    // so the chip is information — clicking it must not open a dead editor.
    mount({ workflowKey: "invoice-disputed", codes: [], onEdit: vi.fn() });
    expect(container.textContent).toContain("invoice-disputed");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders codes as inert text when no edit handler is given", () => {
    // A workflow-only manager cannot edit templates; the codes stay visible
    // but must not offer an edit affordance that goes nowhere.
    mount({ workflowKey: "payment-succeeded", codes: ["receipt", "payment-admin-alert"] });
    expect(container.textContent).toContain("receipt");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders — for a workflow with no mapped templates", () => {
    // Scheduled jobs like "overdue" send nothing template-backed; the cell must
    // show the dash rather than an empty box.
    mount({ workflowKey: "overdue", codes: [] });
    expect(container.textContent).toContain("—");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders — for an unknown workflow key", () => {
    mount({ workflowKey: "not-a-workflow", codes: [] });
    expect(container.textContent).toContain("—");
  });
});
