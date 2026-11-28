import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContractPreview } from "./ContractPreview";
import { contractBuilderDefaults } from "@/lib/contractBuilder/schema";
import { FIXTURE_ISSUER } from "@/lib/contractBuilder/schema.fixture";

const COMPANY_LOGO = "https://cdn.example.test/companies/acme/logo.png";

it("renders the unfinished five-page draft inside an unprivileged iframe", () => {
  const markup = renderToStaticMarkup(
    <ContractPreview
      values={contractBuilderDefaults}
      locale="ar"
      issuer={{ ...FIXTURE_ISSUER, logoUrl: COMPANY_LOGO }}
    />,
  );
  expect(markup).toContain('sandbox=""');
  expect(markup).toContain(FIXTURE_ISSUER.name);
  expect(markup).toContain('srcDoc="');
  expect(markup).toContain("class=&quot;doc-page");
  expect(markup).toContain(COMPANY_LOGO);
  expect(markup).not.toContain("danat-logo");
  expect(markup).not.toContain("allow-scripts");
  expect(markup).not.toContain("allow-same-origin");
});

it("prints no logo image when the company has none", () => {
  const markup = renderToStaticMarkup(
    <ContractPreview values={contractBuilderDefaults} locale="ar" issuer={FIXTURE_ISSUER} />,
  );
  expect(markup).not.toContain("&lt;img");
});
