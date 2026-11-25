import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";

const EDITOR = readFileSync(
  join(process.cwd(), "src/components/admin/TemplateEditorDialog.tsx"),
  "utf8",
);
const ROUTE = readFileSync(
  join(process.cwd(), "src/routes/admin.settings.notifications.tsx"),
  "utf8",
);
const TEMPLATES_TABLE = readFileSync(
  join(process.cwd(), "src/components/admin/notifications/NotificationTemplatesTable.tsx"),
  "utf8",
);

describe("TemplateEditorDialog", () => {
  test("the type dropdown offers all 21 types", () => {
    expect(EDITOR).toContain("NOTIFICATION_TYPES.map");
    expect(NOTIFICATION_TYPES).toHaveLength(21);
    expect(EDITOR).not.toMatch(/const notificationTypes/);
  });

  test("switching the language select swaps the edited pair", () => {
    expect(EDITOR).toContain("editLang");
    expect(EDITOR).toMatch(/editLang === "ar" \? draft\.subjectAr : draft\.subjectEn/);
    expect(EDITOR).toMatch(/editLang === "ar" \? draft\.bodyAr : draft\.bodyEn/);
  });

  test("the save payload has no locale key", () => {
    const save = EDITOR.slice(EDITOR.indexOf("const values = {"));
    const block = save.slice(0, save.indexOf("};") + 2);
    expect(block).not.toMatch(/\blocale:/);
    expect(block).toContain("subject_ar");
    expect(block).toContain("body_en");
  });
});

describe("templates table on the notifications settings route", () => {
  test("renders every row with no pager and no language column", () => {
    // The table lives in its own file so the route stays under the line
    // ceiling; the invariant is still "every filtered row, no pager".
    expect(ROUTE).toContain("templates={filteredTemplates}");
    expect(TEMPLATES_TABLE).toContain("sortedTemplates.map");
    expect(ROUTE).not.toContain("templatePage");
    expect(ROUTE).not.toContain("visibleTemplates");
    expect(ROUTE).not.toMatch(/setTemplatePage/);
    expect(TEMPLATES_TABLE).not.toMatch(/template\.locale/);
  });
});
