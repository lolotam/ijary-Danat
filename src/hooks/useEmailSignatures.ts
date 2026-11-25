import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { EmailSignatureRow } from "@/integrations/supabase/database.types";
import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";
import { buildSignatureHtml, type SignatureDetails } from "@/lib/signatureHtml";

const QUERY_KEY = ["email-signatures"] as const;

/**
 * يحمّل توقيعات المستخدم الحالي، الافتراضي أولًا.
 *
 * RLS scopes the rows to the signed-in admin (migration 123), so no explicit
 * `admin_id` filter is needed or wanted — one written here would drift from the
 * policy that actually enforces it.
 */
export function useEmailSignatures(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_signatures")
        .select("*")
        .order("is_default", { ascending: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as EmailSignatureRow[];
    },
  });
}

export interface SignatureInput {
  /** Absent when creating. */
  id?: string;
  name: string;
  details: SignatureDetails;
  isDefault: boolean;
}

/**
 * ينشئ توقيعًا أو يحدّثه، ويضبط الافتراضي عبر دالة قاعدة البيانات.
 *
 * `content_html` is sanitized on the way in, not only when previewed. Cleaning
 * at render time leaves the unsafe value in the database, where the next reader
 * — a report, an export, a component written next year — has no idea it needs
 * cleaning.
 *
 * The default is switched through `set_default_email_signature`, which does
 * both writes in one transaction. Clearing the old default and setting the new
 * one from here would be two round trips: a failure between them leaves the
 * admin with no default at all, and two tabs can both clear and then race into
 * the unique partial index.
 */
export function useSaveSignature() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SignatureInput) => {
      const { data: session } = await supabase.auth.getSession();
      const adminId = session.session?.user.id;
      if (!adminId) throw new Error("Not authenticated.");

      const row = {
        name: input.name.trim(),
        details: input.details as unknown as EmailSignatureRow["details"],
        content_html: sanitizeSignatureHtml(buildSignatureHtml(input.details)),
        updated_at: new Date().toISOString(),
      };

      const saved = input.id
        ? await supabase
            .from("email_signatures")
            .update(row)
            .eq("id", input.id)
            .select("id")
            .single()
        : await supabase
            .from("email_signatures")
            .insert({ ...row, admin_id: adminId })
            .select("id")
            .single();
      if (saved.error) throw new Error(saved.error.message);

      if (input.isDefault) {
        const { error } = await supabase.rpc("set_default_email_signature", {
          _signature_id: saved.data.id,
        });
        if (error) throw new Error(error.message);
      }
      return saved.data.id;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

/**
 * يحذف توقيعًا واحدًا.
 */
export function useDeleteSignature() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("email_signatures").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
