import { safeFilename } from "@/lib/safeFilename";
import type { ContractBuilderValues } from "./schema";

/** يوحّد اسم التنزيل بين المتصفح والخادم دون استيراد وحدات PDF الخاصة بالخادم. */
export function contractPdfFilename(values: ContractBuilderValues): string {
  const party =
    values.second_party_type === "company"
      ? values.company.company_name
      : values.persons[0]?.full_name;
  const source = values.trade_name.trim() || party?.trim() || "contract";
  return `contract-${safeFilename(source)}-${values.contract_date}.pdf`;
}
