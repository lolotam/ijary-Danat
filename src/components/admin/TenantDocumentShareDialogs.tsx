import { useState } from "react";
import { ChevronRight, Download, Mail, MessageCircle, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHostBrandName } from "@/hooks/useHostBrandName";
import type { Tenant, TenantDocument } from "@/hooks/useTenants";
import { useI18n } from "@/i18n/provider";
import {
  buildMailtoUrl,
  buildWhatsAppUrl,
  KUWAIT_PHONE_ERROR,
  resolveDocLinks,
} from "@/lib/shareDocuments";

type ShareChannel = "whatsapp" | "email";

type Translate = (key: string) => string;

export interface UseShareDialogStateArgs {
  selectedDocs: TenantDocument[];
  tenant?: Tenant | null;
  t: Translate;
}

/**
 * يبني عنوان رسالة المشاركة الافتراضي باسم الشركة المرسلة.
 *
 * The default subject used to name one fixed company for every company's
 * mail; it now names the host's company, in the staff member's language.
 */
function defaultShareSubject(locale: string, companyName: string): string {
  return locale === "ar" ? `مستندات من ${companyName}` : `Documents from ${companyName}`;
}

/**
 * يدير حالة نافذتي مشاركة المستندات عبر واتساب والبريد.
 */
export function useShareDialogState({ selectedDocs, tenant, t }: UseShareDialogStateArgs) {
  const { locale } = useI18n();
  const companyName = useHostBrandName();
  const [shareOpen, setShareOpen] = useState<ShareChannel | null>(null);
  const [shareRecipient, setShareRecipient] = useState("");
  const [shareSubject, setShareSubject] = useState(() => defaultShareSubject(locale, companyName));
  const [shareBusy, setShareBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  function closeShare() {
    setShareOpen(null);
    setPhoneError(null);
  }

  function setRecipient(value: string) {
    setShareRecipient(value);
    setPhoneError(null);
  }

  function openShare(channel: ShareChannel) {
    setShareBusy(true);
    try {
      setPhoneError(null);
      if (channel === "whatsapp") {
        setShareRecipient(tenant?.whatsapp ?? tenant?.mobile ?? "");
      } else {
        setShareRecipient(tenant?.email ?? "");
      }
      setShareOpen(channel);
    } finally {
      setShareBusy(false);
    }
  }

  async function sendShare() {
    if (!shareOpen) return;
    if (!shareRecipient.trim()) {
      toast.error(t("documents.shareRecipientRequired"));
      return;
    }
    try {
      setShareBusy(true);
      setPhoneError(null);
      const links = await resolveDocLinks(selectedDocs);
      if (!links.length) {
        toast.error(t("documents.shareNoLinks"));
        return;
      }
      const labels = {
        // The neutral intro ("Your documents:") gains the sender's name, so
        // a renter reading the message knows which company sent the links.
        intro: `${companyName} — ${t("documents.shareIntro")}`,
        expiryNote: t("documents.linksExpireNote"),
      };
      const url =
        shareOpen === "whatsapp"
          ? buildWhatsAppUrl(shareRecipient, links, labels)
          : buildMailtoUrl(shareRecipient, shareSubject, links, labels);
      window.open(url, "_blank", "noopener,noreferrer");
      closeShare();
      toast.success(t("documents.shareOpened"));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("common.error");
      if (shareOpen === "whatsapp" && message === KUWAIT_PHONE_ERROR) {
        setPhoneError(t("common.phoneInvalidKuwait"));
        return;
      }
      toast.error(message);
    } finally {
      setShareBusy(false);
    }
  }

  return {
    shareOpen,
    shareRecipient,
    shareSubject,
    shareBusy,
    phoneError,
    selectedCount: selectedDocs.length,
    tenant,
    openShare,
    closeShare,
    setRecipient,
    setShareSubject,
    sendShare,
  };
}

export type ShareDialogState = ReturnType<typeof useShareDialogState>;

export function TenantDocumentsBulkBar({
  selectedCount,
  shareBusy,
  t,
  onDownloadZip,
  onShareWhatsApp,
  onShareEmail,
  onClear,
}: {
  selectedCount: number;
  shareBusy: boolean;
  t: Translate;
  onDownloadZip: () => void;
  onShareWhatsApp: () => void;
  onShareEmail: () => void;
  onClear: () => void;
}) {
  if (selectedCount <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
      <Badge variant="secondary">
        {t("documents.selected").replace("{{count}}", String(selectedCount))}
      </Badge>
      <Button variant="outline" size="sm" onClick={onDownloadZip}>
        <Download className="size-4" /> {t("documents.downloadZip")}
      </Button>
      <Button variant="outline" size="sm" onClick={onShareWhatsApp} disabled={shareBusy}>
        <MessageCircle className="size-4" /> {t("documents.shareWhatsApp")}
      </Button>
      <Button variant="outline" size="sm" onClick={onShareEmail} disabled={shareBusy}>
        <Mail className="size-4" /> {t("documents.shareEmail")}
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X className="size-4" /> {t("documents.clearSelection")}
      </Button>
      <p className="ml-auto text-xs text-muted-foreground">{t("documents.linksExpireNote")}</p>
    </div>
  );
}

export function TenantDocumentShareDialogs({
  state,
  t,
}: {
  state: ShareDialogState;
  t: Translate;
}) {
  const {
    shareOpen,
    shareRecipient,
    shareSubject,
    shareBusy,
    phoneError,
    selectedCount,
    tenant,
    closeShare,
    setRecipient,
    setShareSubject,
    sendShare,
  } = state;

  return (
    <Dialog open={Boolean(shareOpen)} onOpenChange={(open) => !open && closeShare()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {shareOpen === "whatsapp"
              ? t("documents.shareWhatsAppTitle")
              : t("documents.shareEmailTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("documents.selected").replace("{{count}}", String(selectedCount))} ·{" "}
            {t("documents.linksExpireNote")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>
              {shareOpen === "whatsapp"
                ? t("documents.recipientPhone")
                : t("documents.recipientEmail")}
            </Label>
            <Input
              value={shareRecipient}
              placeholder={
                shareOpen === "whatsapp"
                  ? t("documents.recipientPhonePlaceholder")
                  : t("documents.recipientEmailPlaceholder")
              }
              onChange={(e) => setRecipient(e.target.value)}
            />
            {phoneError ? <p className="text-xs text-destructive">{phoneError}</p> : null}
            {shareOpen === "whatsapp" && (tenant?.whatsapp || tenant?.mobile) ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setRecipient(tenant?.whatsapp ?? tenant?.mobile ?? "")}
              >
                {t("documents.useTenantContact")}
              </button>
            ) : null}
            {shareOpen === "email" && tenant?.email ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setRecipient(tenant.email ?? "")}
              >
                {t("documents.useTenantContact")}
              </button>
            ) : null}
          </div>
          {shareOpen === "email" ? (
            <div className="grid gap-2">
              <Label>{t("documents.shareSubject")}</Label>
              <Input value={shareSubject} onChange={(e) => setShareSubject(e.target.value)} />
            </div>
          ) : null}
          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            {t("documents.sharePreviewNote")}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeShare}>
            {t("common.cancel")}
          </Button>
          <Button onClick={sendShare} disabled={shareBusy}>
            <ChevronRight className="size-4" /> {t("documents.sendNow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
