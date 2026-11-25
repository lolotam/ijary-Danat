import { describe, expect, test } from "vitest";

import type { NotificationChannel } from "@/integrations/supabase/database.types";

import { templateAllowsChannel } from "./templateChannelPolicy";

describe("templateAllowsChannel", () => {
  // Reported 2026-08-14: the overdue-reminder template was set to Email in the
  // editor, yet every tenant holding a number also got a WhatsApp row, and the
  // notification pool filled with skipped WhatsApp reminders nobody asked for.
  const matrix: Array<[NotificationChannel, NotificationChannel, boolean]> = [
    ["email", "email", true],
    ["email", "whatsapp", false],
    ["whatsapp", "whatsapp", true],
    ["whatsapp", "email", false],
    ["both", "email", true],
    ["both", "whatsapp", true],
    // A caller asking for a single `both` row needs a template that permits
    // both; the manual send dialog is the only path that requests it.
    ["both", "both", true],
    ["email", "both", false],
    ["whatsapp", "both", false],
  ];

  test.each(matrix)("a %s template allows a %s row: %s", (templateChannel, requested, allowed) => {
    expect(templateAllowsChannel(templateChannel, requested)).toBe(allowed);
  });

  test("no active template imposes no restriction", () => {
    // Deliberate: loadTemplateCopy degrades a deleted or deactivated template to
    // the built-in copy rather than to silence. Failing closed here would turn a
    // missing row into a money-path outage instead of a cosmetic one.
    expect(templateAllowsChannel(null, "whatsapp")).toBe(true);
    expect(templateAllowsChannel(undefined, "whatsapp")).toBe(true);
  });
});
