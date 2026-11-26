import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { resolveBrowserCompanyId } from "@/company/browserCompany";
import { companyStoragePath } from "@/company/storagePath";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { pageRange } from "@/hooks/pagination";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/database.types";
import { STORAGE_UPLOAD_MAX_BYTES, STORAGE_UPLOAD_MAX_MB } from "@/lib/uploadLimits";

export type TenantMessage = Tables<"tenant_messages">;
export type ContactInquiry = Tables<"contact_inquiries">;

export interface TenantMessageWithTenant extends TenantMessage {
  tenant: { id: string; code: string; name: string } | null;
}

export interface TenantMessageListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  /** When set, filters by status (`new` / `read` / `archived`). */
  status?: TenantMessage["status"];
}

export interface TenantMessageListResult {
  items: TenantMessageWithTenant[];
  count: number;
}

export interface ContactInquiryListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: "new" | "read";
}

export interface ContactInquiryListResult {
  items: ContactInquiry[];
  count: number;
}

/** Admin inbox: tenant messages newest first, with the sending tenant resolved. */
export function useTenantMessages(params: TenantMessageListParams = {}, enabled = true) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, params.pageSize ?? 20);
  const search = params.search ?? "";
  const status = params.status;

  return useQuery({
    queryKey: ["tenant-messages", { page, pageSize, search, status: status ?? null }],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<TenantMessageListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let query = supabase
        .from("tenant_messages")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (status) query = query.eq("status", status);
      const term = normalizePostgrestSearch(search);
      if (term) {
        query = query.or(`subject.ilike.%${term}%,body.ilike.%${term}%`);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      if (!data.length) return { items: [], count: count ?? 0 };
      const { data: tenants, error: tenantError } = await supabase
        .from("tenants")
        .select("id, code, name")
        .in("id", [...new Set(data.map((message) => message.tenant_id))]);
      if (tenantError) throw tenantError;
      const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
      return {
        items: data.map((message) => ({
          ...message,
          tenant: byId.get(message.tenant_id) ?? null,
        })),
        count: count ?? 0,
      };
    },
  });
}

/** Landing-page contact form submissions, newest first. */
export function useContactInquiries(params: ContactInquiryListParams = {}, enabled = true) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, params.pageSize ?? 20);
  const search = params.search ?? "";
  const status = params.status;

  return useQuery({
    queryKey: ["contact-inquiries", { page, pageSize, search, status: status ?? null }],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: async (): Promise<ContactInquiryListResult> => {
      const { from, to } = pageRange(page, pageSize);
      let query = supabase
        .from("contact_inquiries")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);
      if (status) query = query.eq("status", status);
      const term = normalizePostgrestSearch(search);
      if (term) {
        query = query.or(
          `name.ilike.%${term}%,email.ilike.%${term}%,subject.ilike.%${term}%,message.ilike.%${term}%`,
        );
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return { items: data ?? [], count: count ?? 0 };
    },
  });
}

/**
 * Marks a visitor message read (migration 64).
 *
 * Separate from `useUpdateTenantMessageStatus` because the tables are separate,
 * but the status vocabulary is deliberately identical so the header bell can
 * filter both on `status === "new"`.
 */
export function useUpdateContactInquiryStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "new" | "read" }) => {
      const { error } = await supabase.from("contact_inquiries").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contact-inquiries"] }),
  });
}

export function useSendTenantMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      tenantId: string;
      subject: string;
      body: string;
      attachment: File | null;
    }) => {
      let attachmentPath: string | null = null;
      if (input.attachment) {
        if (input.attachment.size > STORAGE_UPLOAD_MAX_BYTES) {
          throw new Error(`Attachment must be smaller than ${STORAGE_UPLOAD_MAX_MB} MB.`);
        }
        const companyId = await resolveBrowserCompanyId();
        const extension =
          input.attachment.name
            .split(".")
            .pop()
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, "") || "bin";
        // مسار مرفقات رسائل المستأجرين يبدأ بمعرّف الشركة ثم المستأجر وفق سياسة التخزين.
        attachmentPath = companyStoragePath(
          companyId,
          `${input.tenantId}/${crypto.randomUUID()}.${extension}`,
        );
        const upload = await supabase.storage
          .from("tenant-messages")
          .upload(attachmentPath, input.attachment, { upsert: false });
        if (upload.error) throw upload.error;
      }
      const { data: session } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("tenant_messages")
        .insert({
          tenant_id: input.tenantId,
          sender_profile_id: session.user?.id ?? null,
          subject: input.subject.trim() || null,
          body: input.body.trim(),
          attachment_path: attachmentPath,
        })
        .select("*")
        .single();
      if (error) {
        if (attachmentPath) await supabase.storage.from("tenant-messages").remove([attachmentPath]);
        throw error;
      }
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenant-messages"] }),
  });
}

export function useUpdateTenantMessageStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: TenantMessage["status"] }) => {
      const { error } = await supabase.from("tenant_messages").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenant-messages"] }),
  });
}

export function useDeleteTenantMessages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return;
      const { data: rows, error: fetchError } = await supabase
        .from("tenant_messages")
        .select("id, attachment_path")
        .in("id", ids);
      if (fetchError) throw fetchError;
      const { error } = await supabase.from("tenant_messages").delete().in("id", ids);
      if (error) throw error;
      const paths = (rows ?? [])
        .map((row) => row.attachment_path)
        .filter((path): path is string => Boolean(path));
      if (paths.length) await supabase.storage.from("tenant-messages").remove(paths);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenant-messages"] }),
  });
}

export function useDeleteContactInquiries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return;
      const { error } = await supabase.from("contact_inquiries").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contact-inquiries"] }),
  });
}

/** Signed URL for a message attachment (private bucket). */
export async function tenantMessageAttachmentUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("tenant-messages").createSignedUrl(path, 300);
  if (error) return null;
  return data.signedUrl;
}
