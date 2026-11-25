import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteWhatsAppContact,
  exportWhatsAppContactsCsv,
  saveWhatsAppContact,
} from "@/fns/whatsappChat";
import { supabase } from "@/integrations/supabase/client";
import type { WhatsappContactRow } from "@/integrations/supabase/database.types";

import { sessionHeaders } from "./whatsappSession";

/**
 * حِزم دليل جهات اتصال واتساب: القراءة والحفظ والحذف والتصدير وخيارات الربط.
 *
 * Split out of `useWhatsAppInbox` when that file passed the size ceiling. The
 * directory is its own subject — names, linked tenants, linked contracts — and
 * shares nothing with the message thread beyond the phone number that keys them
 * together. `useWhatsAppInbox` re-exports every symbol here, so no call site
 * had to move.
 */

/** A linked contract, shaped for the clickable chip. */
export interface ContactContractLink {
  id: string;
  code: string;
}

/**
 * المستأجر المرتبط بجهة الاتصال، بالقدر الذي يحتاجه الرابط والاسم المعروض.
 */
export interface ContactTenantLink {
  id: string;
  name: string;
  name_en: string | null;
}

export type WhatsAppContactWithContracts = WhatsappContactRow & {
  contracts: ContactContractLink[];
  /** null when the contact is not linked to a tenant record. */
  tenant: ContactTenantLink | null;
};

/**
 * يقرأ دليل جهات الاتصال مع عقود كل جهة والمستأجر المرتبط بها.
 *
 * Three bounded queries rather than one embedded join: the link table carries
 * no PostgREST relationship metadata worth teaching for a 500-row list, and the
 * tenant is a plain FK the table renders as a link.
 */
export function useWhatsAppContacts(enabled: boolean, search: string) {
  return useQuery({
    queryKey: ["whatsapp-contacts", search],
    enabled,
    queryFn: async (): Promise<WhatsAppContactWithContracts[]> => {
      let query = supabase
        .from("whatsapp_contacts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (search.trim()) {
        const term = search.trim().replace(/[%_]/g, "");
        query = query.or(`phone.ilike.%${term}%,name.ilike.%${term}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      const contacts = data ?? [];
      if (!contacts.length) return [];

      // Two bounded queries instead of an embedded join: the links table has
      // no PostgREST relationship metadata worth teaching for a 500-row list.
      const links = await supabase
        .from("whatsapp_contact_contracts")
        .select("contact_id, contract_id")
        .in(
          "contact_id",
          contacts.map((contact) => contact.id),
        );
      if (links.error) throw links.error;
      const contractIds = [...new Set((links.data ?? []).map((link) => link.contract_id))];
      const contracts = contractIds.length
        ? await supabase.from("contracts").select("id, code").in("id", contractIds)
        : { data: [], error: null };
      if (contracts.error) throw contracts.error;
      const codeById = new Map((contracts.data ?? []).map((row) => [row.id, row.code]));

      // Third bounded query, same reasoning as the contracts one above: the
      // linked tenant is a plain FK on the contact, and the table shows its
      // name as a link to the tenant page.
      const tenantIds = [
        ...new Set(contacts.map((contact) => contact.tenant_id).filter(Boolean)),
      ] as string[];
      const tenants = tenantIds.length
        ? await supabase.from("tenants").select("id, name, name_en").in("id", tenantIds)
        : { data: [], error: null };
      if (tenants.error) throw tenants.error;
      const tenantById = new Map((tenants.data ?? []).map((row) => [row.id, row]));

      return contacts.map((contact) => ({
        ...contact,
        contracts: (links.data ?? [])
          .filter((link) => link.contact_id === contact.id)
          .map((link) => ({ id: link.contract_id, code: codeById.get(link.contract_id) ?? "—" })),
        tenant: (contact.tenant_id
          ? (tenantById.get(contact.tenant_id) ?? null)
          : null) as ContactTenantLink | null,
      }));
    },
  });
}

/**
 * خيار مستأجر في قائمة جهة الاتصال: الهوية للعرض plus البريد والاسم التجاري
 * للتعبئة التلقائية عند اختيار المستأجر من القائمة.
 */
export interface WhatsAppTenantOption {
  id: string;
  name: string;
  name_en: string | null;
  code: string | null;
  email: string | null;
  commercial_name: string | null;
  commercial_name_ar: string | null;
  commercial_name_en: string | null;
  lifecycle: string;
}

/**
 * قائمة المستأجرين لاختيار جهة الاتصال؛ نفس المصدر والترتيب المستخدمان في
 * `TenantPicker` (المستأجرون المتعاقدون مرتبة برقم المستأجر DANA-00001...).
 *
 * يجلب البريد والأسماء التجارية مع الهوية حتى يعبئ حوار جهة الاتصال
 * البريد والاسم التجاري مباشرة من بيانات المستأجر عند اختياره.
 */
export function useWhatsAppTenantOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["whatsapp-tenant-options"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<WhatsAppTenantOption[]> => {
      const { data: tenants, error } = await supabase
        .from("tenants")
        .select(
          "id, name, name_en, code, email, commercial_name, commercial_name_ar, commercial_name_en, lifecycle",
        )
        .is("archived_at", null)
        .order("code", { ascending: true })
        .limit(1000);
      if (error) throw error;
      if (!tenants?.length) return [];
      const { data: contracts, error: contractError } = await supabase
        .from("contracts")
        .select("tenant_id")
        .in(
          "tenant_id",
          tenants.map((tenant) => tenant.id),
        );
      if (contractError) throw contractError;
      const contracted = new Set((contracts ?? []).map((row) => row.tenant_id));
      return tenants.filter((tenant) => contracted.has(tenant.id));
    },
  });
}

/**
 * عقود مستأجر واحد لقائمة الربط الثانية في نموذج جهة الاتصال.
 */
export function useTenantContractOptions(tenantId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-tenant-contracts", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<ContactContractLink[]> => {
      const { data, error } = await supabase
        .from("contracts")
        .select("id, code")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * يحفظ جهة اتصال (إضافة أو تعديل) ويحدّث القائمة وقائمة المحادثات معاً.
 *
 * The chat list is invalidated too because a contact's name overrides the
 * WhatsApp push name in the thread list — renaming here changes what the other
 * pane shows.
 */
export function useSaveWhatsAppContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      phone: string;
      name?: string;
      commercialName?: string;
      email?: string;
      notes?: string;
      tenantId?: string | null;
      contractIds?: string[];
    }) => {
      const headers = await sessionHeaders();
      return saveWhatsAppContact({ data: input, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
      // Chat rows render the contact's name — a rename must reach the list.
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}

/**
 * يحذف جهة اتصال من الدليل دون المساس بمحادثتها.
 *
 * Deleting the directory entry is not deleting the conversation: the thread and
 * its messages stay, and the chat falls back to the WhatsApp push name.
 */
export function useDeleteWhatsAppContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const headers = await sessionHeaders();
      return deleteWhatsAppContact({ data: { id }, headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-chats"] });
    },
  });
}
