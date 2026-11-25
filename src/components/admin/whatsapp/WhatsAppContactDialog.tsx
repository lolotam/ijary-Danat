import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/admin/whatsapp/WhatsAppChatList";
import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useSaveWhatsAppContact,
  useTenantContractOptions,
  useWhatsAppTenantOptions,
} from "@/hooks/useWhatsAppInbox";
import { useI18n } from "@/i18n/provider";
import { resolvePartyName } from "@/lib/partyName";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";

export interface ContactDraft {
  id?: string;
  phone: string;
  firstName: string;
  lastName: string;
  commercialName: string;
  email: string;
  notes: string;
  /** Empty string = no tenant picked; drives the contracts list below it. */
  tenantId?: string;
  contractIds?: string[];
  /** WhatsApp profile picture synced from Evolution; display-only here. */
  avatarUrl?: string | null;
}

/**
 * يقسم الاسم المخزَّن إلى اسم أول واسم عائلة على أول مسافة.
 *
 * Storage keeps ONE `name` column (what the chat list and CSV export render);
 * the split exists only in this form, so an existing "أحمد الصباح" edits as
 * first "أحمد", last "الصباح" and saves back joined.
 */
export function splitContactName(name: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const spaceAt = trimmed.indexOf(" ");
  if (spaceAt < 0) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, spaceAt), lastName: trimmed.slice(spaceAt + 1).trim() };
}

interface WhatsAppContactDialogProps {
  /** null keeps the dialog closed; a draft opens it seeded with these values. */
  initial: ContactDraft | null;
  onClose: () => void;
  /** Fired after a successful save with the normalised digits. */
  onSaved?: (phone: string) => void;
}

/**
 * حوار إضافة/تعديل جهة اتصال واتساب — يُستخدم من قائمة جهات الاتصال ومن زر
 * "إضافة لجهات الاتصال" في ترويسة المحادثة.
 *
 * State reseeds whenever a new draft arrives, so opening the dialog for a
 * different contact never shows the previous one's fields.
 */
export function WhatsAppContactDialog({ initial, onClose, onSaved }: WhatsAppContactDialogProps) {
  const { t, locale } = useI18n();
  const save = useSaveWhatsAppContact();
  const [draft, setDraft] = useState<ContactDraft | null>(initial);
  const tenants = useWhatsAppTenantOptions(initial !== null);
  const tenantContracts = useTenantContractOptions(draft?.tenantId || null);
  const [tenantSearch, setTenantSearch] = useState("");

  useEffect(() => {
    if (initial === null) setTenantSearch("");
  }, [initial]);

  const filteredTenants = useMemo(() => {
    const list = tenants.data ?? [];
    const needle = tenantSearch.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((tenant) =>
      [tenantDisplayName(tenant as never, locale), tenant.code ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    );
  }, [tenants.data, tenantSearch, locale]);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  function toggleContract(contractId: string, checked: boolean) {
    if (!draft) return;
    const current = new Set(draft.contractIds ?? []);
    if (checked) current.add(contractId);
    else current.delete(contractId);
    setDraft({ ...draft, contractIds: [...current] });
  }

  /**
   * يعبئ البريد والاسم التجاري من بيانات المستأجر المختار.
   *
   * تبديل المستأجر يمسح العقود المربوطة (تخص المستأجر السابق) ويعرض
   * بريد المستأجر واسمه التجاري بلغة الواجهة مباشرة من قاعدة البيانات،
   * فيبقى حقلا جهة الاتصال مرآة لبيانات المستأجر بدل إدخال يدوي.
   */
  function handleTenantChange(tenantId: string) {
    if (!draft) return;
    const selected = (tenants.data ?? []).find((tenant) => tenant.id === tenantId);
    setDraft({
      ...draft,
      tenantId,
      contractIds: [],
      email: selected?.email ?? "",
      commercialName: selected ? resolvePartyName(selected, locale) : draft.commercialName,
    });
  }

  async function onSave() {
    if (!draft) return;
    try {
      const fullName = `${draft.firstName.trim()} ${draft.lastName.trim()}`.trim();
      await save.mutateAsync({
        id: draft.id,
        phone: draft.phone,
        name: fullName || undefined,
        commercialName: draft.commercialName || undefined,
        email: draft.email || undefined,
        notes: draft.notes || undefined,
        tenantId: draft.tenantId || null,
        contractIds: draft.contractIds ?? [],
      });
      toast.success(t("inbox.whatsapp.contactSaved"));
      const phone = draft.phone.replace(/\D/g, "");
      onClose();
      if (phone) onSaved?.(phone);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <Dialog open={initial !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial?.id ? t("inbox.whatsapp.editContact") : t("inbox.whatsapp.addContact")}
          </DialogTitle>
        </DialogHeader>
        {draft ? (
          <div className="space-y-3">
            <div className="flex justify-center">
              <ChatAvatar
                avatarUrl={draft.avatarUrl ?? null}
                initials={(draft.firstName || draft.phone.replace(/\D/g, "")).slice(0, 2)}
                className="size-20 text-lg"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("inbox.whatsapp.contactPhone")}</Label>
              <Input
                dir="ltr"
                value={draft.phone}
                onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                placeholder="+965xxxxxxxx"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("inbox.whatsapp.contactFirstName")}</Label>
                <Input
                  value={draft.firstName}
                  onChange={(event) => setDraft({ ...draft, firstName: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("inbox.whatsapp.contactLastName")}</Label>
                <Input
                  value={draft.lastName}
                  onChange={(event) => setDraft({ ...draft, lastName: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("inbox.whatsapp.contactTenant")}</Label>
              <Select value={draft.tenantId || undefined} onValueChange={handleTenantChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t("inbox.whatsapp.contactTenantPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="max-w-[min(92vw,32rem)]">
                  <div className="p-2">
                    <Input
                      value={tenantSearch}
                      onChange={(event) => setTenantSearch(event.target.value)}
                      placeholder={t("common.search")}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                  </div>
                  {filteredTenants.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      {t("common.noResults")}
                    </p>
                  ) : (
                    filteredTenants.map((tenant, index) => (
                      <SelectItem key={tenant.id} value={tenant.id} className="truncate">
                        <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                          {tenantDisplayName(tenant as never, locale)}
                          {tenant.code ? ` — ${tenant.code}` : ""}
                        </TenantOptionLabel>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("inbox.whatsapp.contactCommercialName")}</Label>
              <Input
                value={draft.commercialName}
                onChange={(event) => setDraft({ ...draft, commercialName: event.target.value })}
                placeholder={t("inbox.whatsapp.contactCommercialNameHint")}
              />
            </div>
            {draft.tenantId ? (
              <div className="space-y-1.5">
                <Label>{t("inbox.whatsapp.contactContracts")}</Label>
                {tenantContracts.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                ) : (tenantContracts.data ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("inbox.whatsapp.contactNoContracts")}
                  </p>
                ) : (
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                    {(tenantContracts.data ?? []).map((contract) => (
                      <label key={contract.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <Checkbox
                          checked={(draft.contractIds ?? []).includes(contract.id)}
                          onCheckedChange={(checked) =>
                            toggleContract(contract.id, checked === true)
                          }
                        />
                        <span dir="ltr">{contract.code}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{t("inbox.whatsapp.contactEmail")}</Label>
              <Input
                dir="ltr"
                type="email"
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("inbox.whatsapp.contactNotes")}</Label>
              <Textarea
                rows={3}
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={save.isPending || !draft?.phone.trim()} onClick={() => void onSave()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
