import { companyClient } from "@/company/companyClient.server";
import { requireRequestCompany } from "@/company/requestCompany.server";
import { contractIssuerFromCompany, type ContractIssuer } from "@/lib/contractBuilder/issuer";
import { contractLogoDataUri } from "@/lib/contractBuilder/logo.server";

/**
 * يقرأ بيانات الطرف الأول للعقد المطبوع من شركة الطلب الحالية.
 *
 * Read on the server from the request's company, never taken from the form
 * input, so a PDF cannot be printed under another company's name. A missing
 * row throws: a contract with a blank first party is worse than an error.
 *
 * The logo comes back inlined as a data URI for the PDF renderer, or null
 * when the company has none or it cannot be fetched — never another file.
 *
 * Lives in a `.server.ts` file so the Node-only company context stays out of
 * the browser bundle that imports the server function next to it.
 */
export async function readContractIssuer(): Promise<ContractIssuer> {
  const company = requireRequestCompany();
  const { data, error } = await companyClient(company.id)
    .from("companies")
    .select("name_ar, name_en, address_ar, address_en, phone, logo_url")
    .eq("id", company.id)
    .maybeSingle();
  if (error) throw new Error(`readContractIssuer(${company.id}) failed: ${error.message}`);
  if (!data) throw new Error(`readContractIssuer: company ${company.id} not found`);
  const issuer = contractIssuerFromCompany(data);
  return { ...issuer, logoUrl: await contractLogoDataUri(issuer.logoUrl, company.id) };
}
