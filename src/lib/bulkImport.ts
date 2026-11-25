import { bulkImport, type BulkImportInput, type BulkImportResult } from "@/fns/bulkImport";
import { supabase } from "@/integrations/supabase/client";

export async function bulkImportRows(input: BulkImportInput): Promise<BulkImportResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required.");
  return bulkImport({
    data: input,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
}
