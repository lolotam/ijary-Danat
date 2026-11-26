import { useRef, useState } from "react";
import { ImageIcon, Loader2, Pencil, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { resolveBrowserCompanyId } from "@/company/browserCompany";
import { companyStoragePath } from "@/company/storagePath";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Switch } from "@/components/ui/switch";
import {
  useDeleteSignature,
  useEmailSignatures,
  useSaveSignature,
} from "@/hooks/useEmailSignatures";
import { useI18n } from "@/i18n/provider";
import { supabase } from "@/integrations/supabase/client";
import type { EmailSignatureRow } from "@/integrations/supabase/database.types";
import { sanitizeSignatureHtml } from "@/lib/sanitizeHtml";
import {
  buildSignatureHtml,
  EMPTY_SIGNATURE_DETAILS,
  type SignatureDetails,
} from "@/lib/signatureHtml";
import { STORAGE_UPLOAD_MAX_BYTES } from "@/lib/uploadLimits";
import { cn } from "@/lib/utils";

/**
 * يقرأ الحقول المنظّمة من صف التوقيع، مع قيم افتراضية عند غيابها.
 *
 * `details` is `jsonb`, so a row written before a field existed simply lacks
 * it. Reading through the empty template keeps every field a string rather
 * than letting `undefined` reach a controlled input.
 */
function detailsFrom(row: EmailSignatureRow): SignatureDetails {
  const stored = (row.details ?? {}) as Partial<SignatureDetails>;
  return { ...EMPTY_SIGNATURE_DETAILS, ...stored };
}

/**
 * اختيار التوقيع وإدارته — إنشاء وتعديل وحذف ورفع الشعار.
 *
 * Logos go to the existing public `branding` bucket under a signatures/ prefix.
 * A logo is an <img src> in a message that lands in an unauthenticated inbox,
 * so it has to be public-read; branding already is (migration 21) and already
 * carries an admin-write policy.
 */
export function SignatureManager({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (signature: EmailSignatureRow | null) => void;
}) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const signatures = useEmailSignatures();
  const save = useSaveSignature();
  const remove = useDeleteSignature();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [details, setDetails] = useState<SignatureDetails>(EMPTY_SIGNATURE_DETAILS);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = signatures.data ?? [];
  const previewHtml = sanitizeSignatureHtml(buildSignatureHtml(details));

  /** يعيد نموذج التحرير إلى حالته الفارغة. */
  function resetForm() {
    setEditingId(null);
    setName("");
    setIsDefault(false);
    setDetails(EMPTY_SIGNATURE_DETAILS);
  }

  /** يحمّل توقيعًا قائمًا في النموذج للتعديل. */
  function startEdit(row: EmailSignatureRow) {
    setEditingId(row.id);
    setName(row.name);
    setIsDefault(row.is_default);
    // Read the structured fields, never re-parse the rendered HTML: parsing
    // returns confidently wrong data the moment the markup stops matching.
    setDetails(detailsFrom(row));
  }

  /** يرفع شعار التوقيع إلى مخزن العلامة التجارية العام. */
  async function uploadLogo(file: File) {
    if (file.size > STORAGE_UPLOAD_MAX_BYTES || !file.type.startsWith("image/")) {
      toast.error(t("settings.brandingFileInvalid"));
      return;
    }
    setUploading(true);
    try {
      const companyId = await resolveBrowserCompanyId();
      const extension =
        file.name
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "") || "png";
      const path = companyStoragePath(companyId, `signatures/${crypto.randomUUID()}.${extension}`);
      const upload = await supabase.storage
        .from("branding")
        .upload(path, file, { upsert: true, cacheControl: "3600" });
      if (upload.error) throw upload.error;
      const { data } = supabase.storage.from("branding").getPublicUrl(path);
      setDetails((current) => ({ ...current, logoUrl: data.publicUrl }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setUploading(false);
    }
  }

  /** يحفظ التوقيع الجديد أو المعدّل. */
  async function submit() {
    if (!name.trim()) {
      toast.error(t("inbox.signature.nameRequired"));
      return;
    }
    try {
      await save.mutateAsync({ id: editingId ?? undefined, name, details, isDefault });
      toast.success(t("common.saved"));
      resetForm();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={selectedId ?? "none"}
        onValueChange={(value) =>
          onSelect(value === "none" ? null : (rows.find((row) => row.id === value) ?? null))
        }
      >
        <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("inbox.signature.select")}>
          <SelectValue placeholder={t("inbox.signature.none")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("inbox.signature.none")}</SelectItem>
          {rows.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {row.name}
              {row.is_default ? " ★" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) resetForm();
          setDialogOpen(next);
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          title={t("inbox.signature.manage")}
          aria-label={t("inbox.signature.manage")}
          onClick={() => setDialogOpen(true)}
        >
          <Settings className="size-4" />
        </Button>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("inbox.signature.manage")}</DialogTitle>
            <DialogDescription>{t("inbox.signature.manageHelp")}</DialogDescription>
          </DialogHeader>

          {rows.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("inbox.signature.yours")}</Label>
              <div className="divide-y rounded-md border">
                {rows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{row.name}</p>
                      {row.is_default && (
                        <span className="text-xs text-muted-foreground">
                          {t("inbox.signature.default")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                        onClick={() => startEdit(row)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-destructive"
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                        onClick={() => remove.mutate(row.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1.5">
              <Label required htmlFor="signature-name">
                {t("inbox.signature.name")}
              </Label>
              <Input
                id="signature-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
              <div className="space-y-2">
                <Label className="text-xs">{t("inbox.signature.logo")}</Label>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file) void uploadLogo(file);
                  }}
                  className={cn(
                    "flex size-28 items-center justify-center rounded-lg border-2 border-dashed",
                    "text-muted-foreground transition-colors hover:border-primary/50",
                  )}
                >
                  {uploading ? (
                    <Loader2 className="size-6 animate-spin" />
                  ) : details.logoUrl ? (
                    <img
                      src={details.logoUrl}
                      alt=""
                      className="size-full rounded-lg object-contain p-1"
                    />
                  ) : (
                    <ImageIcon className="size-7" />
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadLogo(file);
                    event.target.value = "";
                  }}
                />
              </div>

              <div className="grid gap-2">
                <SignatureField
                  label={t("inbox.signature.fullName")}
                  value={details.fullName}
                  onChange={(value) => setDetails((c) => ({ ...c, fullName: value }))}
                />
                <SignatureField
                  label={t("inbox.signature.title")}
                  value={details.title}
                  onChange={(value) => setDetails((c) => ({ ...c, title: value }))}
                />
                <SignatureField
                  label={t("inbox.signature.company")}
                  value={details.company}
                  onChange={(value) => setDetails((c) => ({ ...c, company: value }))}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <SignatureField
                    label={t("inbox.signature.phone")}
                    value={details.phone}
                    onChange={(value) => setDetails((c) => ({ ...c, phone: value }))}
                  />
                  <SignatureField
                    label={t("inbox.signature.email")}
                    value={details.email}
                    onChange={(value) => setDetails((c) => ({ ...c, email: value }))}
                  />
                </div>
                <SignatureField
                  label={t("inbox.signature.website")}
                  value={details.website}
                  onChange={(value) => setDetails((c) => ({ ...c, website: value }))}
                />
              </div>
            </div>

            {previewHtml && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("inbox.signature.preview")}
                </Label>
                {/*
                  The one dangerouslySetInnerHTML in this feature, and a
                  deliberate exception to the rule MessagePreviewPanel follows.
                  That component renders admin-authored *template* markup and so
                  uses a sandboxed iframe. This content is first-party: generated
                  by buildSignatureHtml from escaped fields, with hostile URL
                  schemes rejected there, and sanitized again on write and here
                  on render.
                */}
                <div
                  className="rounded-lg border bg-background p-4"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch id="signature-default" checked={isDefault} onCheckedChange={setIsDefault} />
              <Label htmlFor="signature-default">{t("inbox.signature.setDefault")}</Label>
            </div>

            <div className="flex justify-end gap-2">
              {editingId && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  {t("common.cancel")}
                </Button>
              )}
              <Button type="button" onClick={submit} disabled={save.isPending}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />}
                {editingId ? t("common.save") : t("common.add")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * حقل نصّي مصغّر داخل نموذج التوقيع.
 */
function SignatureField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        className="h-8 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
