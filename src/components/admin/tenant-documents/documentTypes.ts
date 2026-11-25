import type { TenantDocumentType } from "@/integrations/supabase/database.types";

/** أنواع وثائق المستأجر بترتيب عرضها في القوائم. */
export const TENANT_DOCUMENT_TYPES: TenantDocumentType[] = [
  "civil_id",
  "commercial_license",
  "power_of_attorney",
  "authorized_signature",
  "contract",
  "payment_evidence",
  "other",
];
