import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { resolveUploadCompanyId } from "@/company/browserCompany";
import { companyStoragePath, extractCompanyIdFromStoragePath } from "@/company/storagePath";
import { attachActiveLocations } from "@/hooks/attachTenantLocations";
import { type ArchiveMode, DEFAULT_ARCHIVE_MODE } from "@/hooks/archiveMode";
import { pageRange } from "@/hooks/pagination";
import { usePermissions } from "@/hooks/usePermissions";
import { normalizePostgrestSearch } from "@/hooks/querySearch";
import { supabase } from "@/integrations/supabase/client";
import type {
  Tables,
  TablesInsert,
  TablesUpdate,
  TenantCategory,
  TenantDocumentType,
  TenantLifecycle,
} from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { fetchExportRows } from "@/lib/pagedQuery";
import { PERMISSIONS } from "@/lib/permissions";
import {
  STORAGE_UPLOAD_MAX_BYTES,
  STORAGE_UPLOAD_MAX_MB,
  STORAGE_UPLOAD_TIMEOUT_MS,
  storageUploadFailureCode,
  withTimeout,
} from "@/lib/uploadLimits";

export type { ArchiveMode } from "@/hooks/archiveMode";
import type { TenantWithActiveLocation } from "@/hooks/attachTenantLocations";

export { useUpdateTenant } from "@/hooks/useUpdateTenant";

export type {
  TenantActiveLocation,
  TenantContractStatus,
  TenantWithActiveLocation,
} from "@/hooks/attachTenantLocations";
export { buildTenantActiveLocations, primaryShopBrandUrls } from "@/hooks/attachTenantLocations";

export type Tenant = Tables<"tenants">;
export type TenantDocument = Tables<"tenant_documents">;

export interface TenantListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: TenantCategory;
  lifecycle?: TenantLifecycle;
  /**
   * Archive slice. Default `current` so every existing call site is unchanged.
   * Part of the query key — switching tabs must not serve a wrong-mode cache.
   */
  archiveMode?: ArchiveMode;
}

/**
 * يجلب مدى صفوف المستأجرين المطابقة للمرشّحات — اللب المشترك بين القائمة والتصدير.
 *
 * Locations are attached by the caller, not here: the export attaches them once
 * over every page instead of per page, which is one round trip rather than one
 * per thousand rows.
 */
async function fetchTenantRange(
  params: Omit<TenantListParams, "page" | "pageSize">,
  from: number,
  to: number,
): Promise<{ rows: Tenant[]; count: number }> {
  const { search = "", category, lifecycle, archiveMode = DEFAULT_ARCHIVE_MODE } = params;
  let query = supabase
    .from("tenants")
    .select("*", { count: "exact" })
    // Close-out with outcome=archive stamps archived_at and disables the
    // portal. The list filter is mode-aware (current / archived / all).
    // Nothing is deleted; `useTenant(id)` still resolves the row.
    // `id` is the unique tiebreaker. `created_at` alone is not unique, and an
    // offset page boundary that falls between two rows sharing a timestamp can
    // return one of them twice and skip the other. A total order makes each
    // page boundary deterministic (Codex review, PR #218).
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (archiveMode === "current") query = query.is("archived_at", null);
  else if (archiveMode === "archived") query = query.not("archived_at", "is", null);
  if (category) query = query.eq("category", category);
  if (lifecycle) query = query.eq("lifecycle", lifecycle);
  const term = normalizePostgrestSearch(search);
  if (term) {
    query = query.or(
      `code.ilike.%${term}%,name.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%`,
    );
  }
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data ?? [], count: count ?? 0 };
}

export function useTenants(params: TenantListParams = {}, enabled = true) {
  const {
    page = 1,
    pageSize = 10,
    search = "",
    category,
    lifecycle,
    archiveMode = DEFAULT_ARCHIVE_MODE,
  } = params;
  return useQuery({
    // archiveMode is in the key so switching Current/Archived/All never serves
    // a cached list from the wrong mode.
    queryKey: ["tenants", { page, pageSize, search, category, lifecycle, archiveMode }],
    enabled,
    queryFn: async () => {
      const { from, to } = pageRange(page, pageSize);
      const { rows, count } = await fetchTenantRange(
        { search, category, lifecycle, archiveMode },
        from,
        to,
      );
      const items = await attachActiveLocations(rows);
      return { items, count };
    },
  });
}

/**
 * بيانات تصدير المستأجرين: كل الصفوف المطابقة صفحةً صفحة بدل أول 500 فقط.
 */
export async function fetchTenantExport(
  params: Omit<TenantListParams, "page" | "pageSize">,
): Promise<{ items: TenantWithActiveLocation[]; count: number; truncated: boolean }> {
  const { rows, count, truncated } = await fetchExportRows((from, to) =>
    fetchTenantRange(params, from, to),
  );
  return { items: await attachActiveLocations(rows), count, truncated };
}

/** استعلام تصدير المستأجرين: كل الصفوف المطابقة، لا أول صفحة. */
export function useTenantExport(
  params: Omit<TenantListParams, "page" | "pageSize"> = {},
  enabled = true,
) {
  const { search = "", category, lifecycle, archiveMode = DEFAULT_ARCHIVE_MODE } = params;
  return useQuery({
    queryKey: ["tenants", "export", { search, category, lifecycle, archiveMode }],
    enabled,
    queryFn: () => fetchTenantExport({ search, category, lifecycle, archiveMode }),
  });
}

export function useTenant(id: string | null) {
  return useQuery({
    queryKey: ["tenant", id],
    enabled: Boolean(id),
    queryFn: async (): Promise<Tenant> => {
      const { data, error } = await supabase.from("tenants").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * A tenant's documents, optionally narrowed to one contract.
 *
 * With a `contractId`, the result is that contract's documents *plus* every
 * untagged one. Migration 77 added `contract_id` nullable and backfilled
 * nothing, so all of today's documents are untagged and go on appearing under
 * every contract exactly as they did before the column existed.
 */
export function useTenantDocuments(tenantId: string | null, contractId?: string | null) {
  return useQuery({
    queryKey: ["tenant-documents", tenantId, contractId ?? null],
    enabled: Boolean(tenantId),
    queryFn: async (): Promise<TenantDocument[]> => {
      let query = supabase.from("tenant_documents").select("*").eq("tenant_id", tenantId!);
      if (contractId) query = query.or(`contract_id.eq.${contractId},contract_id.is.null`);
      const { data, error } = await query.order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * معرّفات المستأجرين الذين لديهم وثيقة واحدة على الأقل، كمجموعة سريعة الفحص.
 *
 * تُستخدم لإشارة "لديه وثائق" على أيقونة الوثائق في صف المستأجر. الاستعلام
 * يقرأ عمود tenant_id فقط من جدول tenant_documents بدل جلب صفوف كاملة،
 * والمفتاح جذر ["tenant-documents"] فتُلغى صلاحيته تلقائيًا مع أي طفرة وثائق.
 */
export function useTenantIdsWithDocuments(enabled = true) {
  return useQuery({
    queryKey: ["tenant-documents", "ids"],
    enabled,
    queryFn: async (): Promise<Set<string>> => {
      const { data, error } = await supabase.from("tenant_documents").select("tenant_id");
      if (error) throw error;
      return new Set(data.map((row) => row.tenant_id));
    },
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (values: TablesInsert<"tenants">) => {
      if (!permissions.can(PERMISSIONS.TENANTS_CREATE)) throw new Error("Permission denied.");
      const { data, error } = await supabase.from("tenants").insert(values).select("*").single();
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "tenant.create",
        entityType: "tenant",
        entityId: data.id,
        after: { ...data },
      });
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

/**
 * Blocks or unblocks a tenant — the only manual lifecycle write left after
 * migration 54 made the column derived.
 *
 * It goes through the `set_tenant_blocked` RPC rather than updating the column
 * directly because unblocking has to land on the *computed* state: writing
 * 'active' blindly would leave a contractless tenant claiming to be active until
 * their next contract write, which is exactly the drift T8 removes.
 */
export function useSetTenantBlocked() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({ id, blocked }: { id: string; blocked: boolean }) => {
      if (!permissions.can(PERMISSIONS.TENANTS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { data: lifecycle, error } = await supabase.rpc("set_tenant_blocked", {
        _tenant: id,
        _blocked: blocked,
      });
      if (error) throw error;
      await logAuditForCurrentSession({
        action: blocked ? "tenant.block" : "tenant.unblock",
        entityType: "tenant",
        entityId: id,
        before: { lifecycle: before.lifecycle },
        after: { lifecycle },
      });
      return { id, lifecycle };
    },
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["tenant", id] });
    },
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!permissions.can(PERMISSIONS.TENANTS_DELETE)) throw new Error("Permission denied.");
      const { count, error: referenceError } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", id);
      if (referenceError) throw referenceError;
      if (count) throw new Error("This tenant is referenced by a contract and cannot be deleted.");
      const { data: before, error: beforeError } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      const { error } = await supabase.from("tenants").delete().eq("id", id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "tenant.delete",
        entityType: "tenant",
        entityId: id,
        before: { ...before },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

export interface TenantDocumentUpload {
  tenantId: string;
  companyId: string;
  file: File;
  type: TenantDocumentType;
  displayName?: string;
  /** Tags the upload to one contract. Omitted uploads stay tenant-wide. */
  contractId?: string | null;
}

export const TENANT_DOCUMENT_MAX_BYTES = STORAGE_UPLOAD_MAX_BYTES;
export const TENANT_DOCUMENT_MAX_MB = STORAGE_UPLOAD_MAX_MB;
export const TENANT_DOCUMENT_TOO_LARGE = "TENANT_DOCUMENT_TOO_LARGE";
export const TENANT_DOCUMENT_UNSUPPORTED_TYPE = "TENANT_DOCUMENT_UNSUPPORTED_TYPE";

function documentStoragePath(companyId: string, tenantId: string, file: File) {
  const extension = file.name
    .split(".")
    .pop()
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const filename = `${crypto.randomUUID()}${extension ? `.${extension}` : ""}`;
  return companyStoragePath(companyId, `tenants/${tenantId}/documents/${filename}`);
}

/**
 * يرفض الملف قبل طلب التخزين إذا تجاوز السقف أو لم يكن PDF/صورة.
 *
 * The thrown codes are stable sentinels the UI maps to i18n; do not
 * localise them here — the hook has no locale.
 */
export function validateDocumentFile(file: File) {
  if (file.size > TENANT_DOCUMENT_MAX_BYTES) {
    throw new Error(TENANT_DOCUMENT_TOO_LARGE);
  }
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.type.toLowerCase().startsWith("image/");
  if (!isPdf && !isImage) {
    throw new Error(TENANT_DOCUMENT_UNSUPPORTED_TYPE);
  }
}

export function useUploadTenantDocument() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      tenantId,
      companyId,
      file,
      type,
      displayName,
      contractId,
    }: TenantDocumentUpload) => {
      if (!permissions.can(PERMISSIONS.TENANTS_UPDATE)) throw new Error("Permission denied.");
      validateDocumentFile(file);
      const resolvedCompanyId = await resolveUploadCompanyId(companyId);
      const path = documentStoragePath(resolvedCompanyId, tenantId, file);
      let uploaded: { error: { message?: string; statusCode?: string | number } | null };
      try {
        uploaded = await withTimeout(
          supabase.storage.from("tenant-documents").upload(path, file, { upsert: false }),
          STORAGE_UPLOAD_TIMEOUT_MS,
          "Upload",
        );
      } catch (error) {
        throw new Error(
          storageUploadFailureCode(error) ??
            (error instanceof Error ? error.message : "Upload failed"),
          { cause: error },
        );
      }
      if (uploaded.error) {
        throw new Error(
          storageUploadFailureCode(uploaded.error) ?? uploaded.error.message ?? "Upload failed",
        );
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("tenant_documents")
        .insert({
          tenant_id: tenantId,
          contract_id: contractId ?? null,
          type,
          storage_path: path,
          display_name: displayName || file.name,
          mime_type: file.type || null,
          size_bytes: file.size,
          uploaded_by: user?.id ?? null,
        })
        .select("*")
        .single();
      if (error) {
        await supabase.storage.from("tenant-documents").remove([path]);
        throw error;
      }
      try {
        await logAuditForCurrentSession({
          action: "tenant_document.create",
          entityType: "tenant_document",
          entityId: data.id,
          after: { ...data },
        });
      } catch (auditError) {
        console.error("tenant_document.create audit failed:", auditError);
      }
      return data;
    },
    onSuccess: (document) => {
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", document.tenant_id] });
      // قائمة المعرّفات التي تُغذّي إشارة "لديه وثائق" في الجدول.
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", "ids"] });
    },
  });
}

export type TenantDocumentUpdateInput =
  | { mode: "keep"; id: string; displayName?: string; type?: TenantDocumentType }
  | { mode: "replace"; id: string; file: File; displayName?: string; type?: TenantDocumentType };

export function useUpdateTenantDocument() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: TenantDocumentUpdateInput) => {
      if (!permissions.can(PERMISSIONS.TENANTS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("tenant_documents")
        .select("*")
        .eq("id", input.id)
        .single();
      if (beforeError) throw beforeError;

      let nextPath: string = before.storage_path;
      let nextMimeType: string | null = before.mime_type;
      let nextSize: number | null = before.size_bytes;
      let uploadedNewPath: string | null = null;

      if (input.mode === "replace") {
        validateDocumentFile(input.file);
        const companyId = await resolveUploadCompanyId(
          extractCompanyIdFromStoragePath(before.storage_path),
        );
        const newPath = documentStoragePath(companyId, before.tenant_id, input.file);
        const { error: uploadError } = await supabase.storage
          .from("tenant-documents")
          .upload(newPath, input.file, { upsert: false });
        if (uploadError) throw uploadError;
        uploadedNewPath = newPath;
        nextPath = newPath;
        nextMimeType = input.file.type || null;
        nextSize = input.file.size;
      }

      const patch: TablesUpdate<"tenant_documents"> = {
        storage_path: nextPath,
        mime_type: nextMimeType,
        size_bytes: nextSize,
      };
      if (input.displayName !== undefined) patch.display_name = input.displayName;
      if (input.type !== undefined) patch.type = input.type;

      const { data: after, error } = await supabase
        .from("tenant_documents")
        .update(patch)
        .eq("id", input.id)
        .select("*")
        .single();
      if (error) {
        if (uploadedNewPath) {
          await supabase.storage.from("tenant-documents").remove([uploadedNewPath]);
        }
        throw error;
      }

      if (input.mode === "replace" && before.storage_path && uploadedNewPath) {
        await supabase.storage.from("tenant-documents").remove([before.storage_path]);
      }

      await logAuditForCurrentSession({
        action: "tenant_document.update",
        entityType: "tenant_document",
        entityId: input.id,
        before: { ...before },
        after: { ...after },
      });
      return after;
    },
    onSuccess: (document) => {
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", document.tenant_id] });
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", "ids"] });
    },
  });
}

/**
 * ينشئ رابطاً موقّتاً لمستند مستأجر للمعاينة أو الجلب.
 *
 * Deliberately takes no `download` option: naming a download through the
 * signed URL mangles non-ASCII names (see downloadStoredFile). Callers that
 * save a file go through downloadStoredFile instead.
 */
export async function createTenantDocumentSignedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from("tenant-documents")
    .createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

export function useDeleteTenantDocument() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (document: TenantDocument) => {
      if (!permissions.can(PERMISSIONS.TENANTS_UPDATE)) throw new Error("Permission denied.");
      const { error: storageError } = await supabase.storage
        .from("tenant-documents")
        .remove([document.storage_path]);
      if (storageError) throw storageError;
      const { error } = await supabase.from("tenant_documents").delete().eq("id", document.id);
      if (error) throw error;
      await logAuditForCurrentSession({
        action: "tenant_document.delete",
        entityType: "tenant_document",
        entityId: document.id,
        before: { ...document },
      });
      return document.tenant_id;
    },
    onSuccess: (tenantId) => {
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["tenant-documents", "ids"] });
    },
  });
}
