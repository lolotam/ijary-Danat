import { renderToStaticMarkup } from "react-dom/server";
import { Building } from "lucide-react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "@/components/ui/empty-state";

describe("EmptyState", () => {
  it("renders the icon, title, description and action", () => {
    const markup = renderToStaticMarkup(
      <EmptyState icon={Building} title="No shops yet" description="Add one to get started">
        <button type="button">Add Store</button>
      </EmptyState>,
    );

    expect(markup).toContain("No shops yet");
    expect(markup).toContain("Add one to get started");
    expect(markup).toContain("Add Store");
    // The icon slot must actually render the Lucide icon, not just reserve space.
    expect(markup).toContain("<svg");
  });

  it("omits the description and action slots when not given", () => {
    const markup = renderToStaticMarkup(<EmptyState icon={Building} title="Nothing here" />);

    expect(markup).toContain("Nothing here");
    expect(markup).not.toContain("<button");
  });
});
