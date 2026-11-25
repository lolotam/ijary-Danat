import { useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import { copyToClipboard } from "@/components/admin/invoices/copyToClipboard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { LtrText } from "@/components/ui/ltr-text";
import { sendNotification } from "@/fns/sendNotification";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/i18n/provider";

export interface KnetLinkInfo {
  /** Invoice code the payment request was created for. */
  code: string;
  url: string;
  tenantId: string;
  tenantEmail: string | null;
  tenantWhatsapp: string | null;
}

interface KnetLinkDialogProps {
  link: KnetLinkInfo | null;
  onClose: () => void;
}

/**
 * حوار رابط كي نت: يعرض الرابط مع نسخ وإغلاق، وإرساله للمستأجر عبر واتساب
 * أو البريد أو كليهما مباشرة من نفس الحوار.
 *
 * The link is shown, not just copied — a payment request already exists at
 * the gateway, so walking away without the URL strands it. Sending goes
 * through the sendNotification server fn, so every send lands as a row in
 * the notification pool and a write_audit entry exactly like a manual send.
 */
export function KnetLinkDialog({ link, onClose }: KnetLinkDialogProps) {
  const { t } = useI18n();
  const [channels, setChannels] = useState({ email: false, whatsapp: true });
  const [sending, setSending] = useState(false);

  const channel =
    channels.email && channels.whatsapp ? "both" : channels.email ? "email" : "whatsapp";
  const canSend =
    (channels.email && !!link?.tenantEmail) || (channels.whatsapp && !!link?.tenantWhatsapp);

  async function onSend() {
    if (!link || sending) return;
    setSending(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Authentication required.");
      await sendNotification({
        data: {
          tenantId: link.tenantId,
          channel,
          type: "manual_message",
          subject: t("invoices.knetSendSubject"),
          body: `${t("invoices.knetSendBody").replace("{code}", link.code)}\n${link.url}`,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      toast.success(t("invoices.knetSendDone"));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={Boolean(link)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("invoices.knetLink")}</DialogTitle>
          <DialogDescription>{link?.code}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label>{t("invoices.knetLinkLabel")}</Label>
          <Input
            readOnly
            dir="ltr"
            value={link?.url ?? ""}
            onFocus={(event) => event.target.select()}
          />
        </div>

        <div className="grid gap-2">
          <Label>{t("invoices.knetSendVia")}</Label>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border p-2.5">
              <Checkbox
                checked={channels.whatsapp}
                disabled={!link?.tenantWhatsapp}
                onCheckedChange={(checked) =>
                  setChannels((current) => ({ ...current, whatsapp: checked === true }))
                }
              />
              <div className="min-w-0">
                <span className="block text-sm font-medium">{t("invoices.channelWhatsapp")}</span>
                <LtrText as="span" className="block truncate text-xs text-muted-foreground">
                  {link?.tenantWhatsapp ?? t("invoices.noWhatsapp")}
                </LtrText>
              </div>
            </label>
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border p-2.5">
              <Checkbox
                checked={channels.email}
                disabled={!link?.tenantEmail}
                onCheckedChange={(checked) =>
                  setChannels((current) => ({ ...current, email: checked === true }))
                }
              />
              <div className="min-w-0">
                <span className="block text-sm font-medium">{t("invoices.channelEmail")}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {link?.tenantEmail ?? t("invoices.noEmail")}
                </span>
              </div>
            </label>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              if (link && (await copyToClipboard(link.url)))
                toast.success(t("invoices.knetLinkCopied"));
            }}
          >
            {t("invoices.knetLinkCopy")}
          </Button>
          <Button disabled={sending || !canSend} onClick={() => void onSend()}>
            {sending ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Send className="size-4 rtl:-scale-x-100" />
            )}
            {t("invoices.knetSend")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
