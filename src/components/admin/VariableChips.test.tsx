import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { insertAtCursor } from "@/components/admin/VariableChips";

describe("insertAtCursor", () => {
  it("inserts at the caret rather than appending", () => {
    // Appending is the naive implementation and it puts every variable at the
    // end of the message regardless of where the admin was typing.
    const result = insertAtCursor("عزيزنا ، أهلاً بك", "{{tenant_name}}", 7, 7);

    expect(result.text).toBe("عزيزنا {{tenant_name}}، أهلاً بك");
  });

  it("reports the caret position after the inserted token", () => {
    const result = insertAtCursor("Total: ", "{{outstanding}}", 7, 7);

    expect(result.text).toBe("Total: {{outstanding}}");
    expect(result.caret).toBe(22);
  });

  it("replaces the selected range", () => {
    const result = insertAtCursor("Dear NAME here", "{{tenant_name}}", 5, 9);

    expect(result.text).toBe("Dear {{tenant_name}} here");
    expect(result.caret).toBe(20);
  });

  it("handles an empty body", () => {
    const result = insertAtCursor("", "{{unit}}", 0, 0);

    expect(result.text).toBe("{{unit}}");
    expect(result.caret).toBe(8);
  });
});

describe("VariableChips", () => {
  const SOURCE = readFileSync(
    join(process.cwd(), "src/components/admin/VariableChips.tsx"),
    "utf8",
  );

  it("disables a variable with no value rather than hiding it", () => {
    // An admin who expects a balance needs to see this tenant has none, not to
    // wonder where the button went.
    expect(SOURCE).toMatch(/disabled=\{!value\}/);
  });

  it("shows the resolved value beside each label", () => {
    // The whole point: pick a variable by the value it will produce, not by
    // guessing a name from a hand-written list that can drift.
    expect(SOURCE).toMatch(/\{value \|\| "∅"\}/);
  });
});
