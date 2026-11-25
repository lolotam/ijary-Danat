import { useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Company, useUpdateCompany } from "@/hooks/useCompany";

interface CompanyContactFormProps {
  company: Company;
  updateCompany: ReturnType<typeof useUpdateCompany>;
  t: (key: string) => string;
  locale: "ar" | "en";
}

/**
 * نموذج بيانات التواصل في صفحة الهبوط؛ يحفظ كل حقل عند مغادرته.
 */
export function CompanyContactForm({ company, updateCompany, t, locale }: CompanyContactFormProps) {
  const [phone, setPhone] = useState(company.phone ?? "");
  const [whatsapp, setWhatsapp] = useState(company.whatsapp ?? "");
  const [email, setEmail] = useState(company.email ?? "");
  const [addressAr, setAddressAr] = useState(company.address_ar ?? "");
  const [addressEn, setAddressEn] = useState(company.address_en ?? "");
  const [mapUrl, setMapUrl] = useState(company.map_url ?? "");

  /** يحفظ حقلاً واحداً من صف الشركة، والفارغ يُحفظ null. */
  async function save(
    field: "phone" | "whatsapp" | "email" | "address_ar" | "address_en" | "map_url",
    value: string,
  ) {
    try {
      await updateCompany.mutateAsync({
        id: company.id,
        updates: { [field]: value.trim() || null },
      });
      toast.success(t("settings.saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("settings.saveError"));
    }
  }

  const fieldDefs: Array<{
    key: "phone" | "whatsapp" | "email" | "address_ar" | "address_en" | "map_url";
    label: string;
    value: string;
    setValue: (v: string) => void;
    type?: string;
    multiline?: boolean;
    help?: string;
  }> = [
    { key: "phone", label: t("settings.phone"), value: phone, setValue: setPhone, type: "tel" },
    {
      key: "whatsapp",
      label: t("settings.whatsapp"),
      value: whatsapp,
      setValue: setWhatsapp,
      type: "tel",
    },
    { key: "email", label: t("settings.email"), value: email, setValue: setEmail, type: "email" },
    {
      key: "address_ar",
      label: t("settings.addressAr"),
      value: addressAr,
      setValue: setAddressAr,
      multiline: true,
    },
    {
      key: "address_en",
      label: t("settings.addressEn"),
      value: addressEn,
      setValue: setAddressEn,
      multiline: true,
    },
    {
      key: "map_url",
      label: t("settings.mapUrl"),
      value: mapUrl,
      setValue: setMapUrl,
      help: t("landingSettings.pasteAGoogleMapsShare"),
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {fieldDefs.map((field) => (
        <div key={field.key} className="space-y-2">
          <Label htmlFor={`loc-${field.key}`}>{field.label}</Label>
          {field.multiline ? (
            <Textarea
              id={`loc-${field.key}`}
              value={field.value}
              onChange={(e) => field.setValue(e.target.value)}
              onBlur={(e) => save(field.key, e.target.value)}
              rows={2}
            />
          ) : (
            <Input
              id={`loc-${field.key}`}
              type={field.type ?? "text"}
              value={field.value}
              onChange={(e) => field.setValue(e.target.value)}
              onBlur={(e) => save(field.key, e.target.value)}
            />
          )}
          {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
        </div>
      ))}
    </div>
  );
}
