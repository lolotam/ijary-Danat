import type { TenantDocument } from "@/hooks/useTenants";
import type { TenantDocumentType } from "@/integrations/supabase/database.types";

/** حالة حوار تعديل الوثيقة: الإبقاء على الملف أو استبداله. */
export interface DocumentEditState {
  document: TenantDocument;
  mode: "keep" | "replace";
  file?: File;
  displayName: string;
  type: TenantDocumentType;
}

/** يفتح حالة التعديل لوثيقة بقيمها الحالية ودون ملف بديل. */
export function editStateFor(doc: TenantDocument): DocumentEditState {
  return { document: doc, mode: "keep", displayName: doc.display_name ?? "", type: doc.type };
}
