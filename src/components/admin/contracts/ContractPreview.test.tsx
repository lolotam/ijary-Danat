import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContractPreview } from "./ContractPreview";
import { CONTRACT_LOGO_PUBLIC_URL } from "@/lib/contractBuilder/html";
import { contractBuilderDefaults } from "@/lib/contractBuilder/schema";

it("renders the unfinished five-page draft inside an unprivileged iframe", () => {
  const markup = renderToStaticMarkup(
    <ContractPreview values={contractBuilderDefaults} locale="ar" />,
  );
  expect(markup).toContain('sandbox=""');
  expect(markup).toContain('srcDoc="');
  expect(markup).toContain("class=&quot;doc-page");
  expect(markup).toContain(CONTRACT_LOGO_PUBLIC_URL);
  expect(markup).not.toContain("allow-scripts");
  expect(markup).not.toContain("allow-same-origin");
});
