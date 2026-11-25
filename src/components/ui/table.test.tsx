import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { I18nProvider } from "@/i18n/provider";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

function renderTable(tableDirection?: "ltr" | "rtl") {
  return renderToStaticMarkup(
    <I18nProvider>
      <Table dir={tableDirection}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Value</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </I18nProvider>,
  );
}

describe("Table", () => {
  test("uses the active Arabic direction and logical header and cell alignment", () => {
    const markup = renderTable();

    expect(markup).toContain('dir="rtl"');
    // Row height is deliberately not asserted here — this test is about the
    // logical alignment, and pinning the height made a type-scale change look
    // like an RTL regression.
    expect(markup).toContain("px-2 text-start align-middle");
    expect(markup).toContain("p-2 text-start align-middle");
  });

  test("header row is bold and tinted so it reads as a header, not a first row", () => {
    const markup = renderTable();

    expect(markup).toContain("font-semibold");
    expect(markup).toContain("bg-muted/60");
    // A muted *foreground* is what made the header recede into the body; the
    // tint carries the separation now, so the text itself is full contrast.
    expect(markup).not.toContain("font-medium text-muted-foreground");
  });

  test("TableHead aligns logically, never by a physical direction", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      </I18nProvider>,
    );

    // `text-start` is what makes a header follow the locale — left under LTR,
    // right under RTL. Every other token here pins it to one side regardless of
    // language, which is the regression this test exists to catch.
    expect(markup).toContain("text-start");
    expect(markup).not.toContain("text-center");
    expect(markup).not.toContain("text-left");
    expect(markup).not.toContain("text-right");
    expect(markup).not.toContain("text-end");
  });

  test("TableCell is not centered — body alignment stays start", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Value</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </I18nProvider>,
    );

    expect(markup).toContain("text-start");
    expect(markup).not.toContain("text-center");
  });

  test("caller-supplied non-alignment class still lands on TableHead", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      </I18nProvider>,
    );

    expect(markup).toContain("w-12");
    expect(markup).toContain("text-start");
  });

  test("preserves an explicit table direction", () => {
    expect(renderTable("ltr")).toContain('dir="ltr"');
  });

  test("renders outside the i18n provider", () => {
    expect(() =>
      renderToStaticMarkup(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>Value</TableCell>
            </TableRow>
          </TableBody>
        </Table>,
      ),
    ).not.toThrow();
  });
});
