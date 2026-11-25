import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Card, CardHeader, CardTitle } from "./card";

describe("CardTitle", () => {
  test("contributes a heading to the document outline", () => {
    const markup = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>Portfolio balance</CardTitle>
        </CardHeader>
      </Card>,
    );

    expect(markup).toContain("<h3");
    expect(markup).toContain("Portfolio balance</h3>");
  });
});
