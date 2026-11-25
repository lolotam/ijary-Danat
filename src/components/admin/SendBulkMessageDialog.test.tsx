import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * تتحقّق من ربط الحوار الجماعي بالبوابتين، لا من سلوكه المعروض.
 *
 * These are WIRING assertions over the component source, not behaviour. Stated
 * plainly rather than dressed up: the suite runs on `environment: "node"` and
 * this dialog pulls react-query, the Supabase client and the i18n provider, so a
 * faithful render here would be mostly mock.
 *
 * The behaviour these lines stand in for is genuinely covered elsewhere, and
 * that is why this file stays thin:
 *
 *   - which templates are offered → `selectEligibleTemplates` in
 *     `src/hooks/useTenantEligibleTemplates.test.ts` (pure, real inputs)
 *   - what the option reads → `TemplateOptionLabel.test.tsx` (rendered markup)
 *   - that an ineligible code cannot be sent → `sendBulkNotification.test.ts`,
 *     which is the actual control; this dropdown is only presentation.
 *
 * What is left for source assertions is the one thing those cannot see: that
 * this dialog is wired to the shared pieces at all, and that it did not grow a
 * copy of the manual dialog's edit-once state — which it has never had, and
 * which an implementer working from the manual dialog would plausibly add.
 */
const SOURCE = readFileSync(
  join(process.cwd(), "src/components/admin/SendBulkMessageDialog.tsx"),
  "utf8",
);

describe("SendBulkMessageDialog wiring", () => {
  test("takes its options from the shared eligibility hook", () => {
    expect(SOURCE).toContain("useTenantEligibleTemplates");
  });

  test("renders options through the shared label component", () => {
    expect(SOURCE).toContain("TemplateOptionLabel");
  });

  test("no longer filters templates by a locale column", () => {
    // The column is gone as of migration 125; a leftover filter would silently
    // empty the dropdown rather than fail.
    expect(SOURCE).not.toMatch(/template\.locale/);
  });

  test("does not invent edit-once state the bulk dialog never had", () => {
    expect(SOURCE).not.toContain("templateEditMode");
    expect(SOURCE).not.toContain("cancelTemplateEdit");
  });
});
