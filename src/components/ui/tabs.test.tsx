import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { I18nProvider } from "@/i18n/provider";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function renderTabs(tabsDirection?: "ltr" | "rtl") {
  return renderToStaticMarkup(
    <I18nProvider>
      <Tabs defaultValue="first" dir={tabsDirection}>
        <TabsList>
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first">Panel</TabsContent>
      </Tabs>
    </I18nProvider>,
  );
}

describe("Tabs", () => {
  test("uses the active Arabic direction so the strip anchors right", () => {
    // Radix defaults `dir` to the literal "ltr" without a DirectionProvider and
    // writes it to the DOM, which overrides the `rtl` inherited from <html>.
    // Without the wrapper this markup reads dir="ltr" on an Arabic page.
    expect(renderTabs()).toContain('dir="rtl"');
  });

  test("preserves an explicit direction", () => {
    expect(renderTabs("ltr")).toContain('dir="ltr"');
  });

  test("renders outside the i18n provider", () => {
    expect(() =>
      renderToStaticMarkup(
        <Tabs defaultValue="only">
          <TabsList>
            <TabsTrigger value="only">Only</TabsTrigger>
          </TabsList>
        </Tabs>,
      ),
    ).not.toThrow();
  });
});
