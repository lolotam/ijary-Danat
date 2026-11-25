import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSendTenantMessage } from "@/hooks/useTenantMessages";
import { useI18n } from "@/i18n/provider";

/**
 * نموذج مراسلة الإدارة من بوابة المستأجر مع مرفق اختياري.
 *
 * Portal-side form; inputs and submit use pointer-coarse min height so touch
 * targets meet 44px without changing the shared ui/input defaults used by admin.
 */
export function TenantMessageForm({ tenantId }: { tenantId: string }) {
  const { t } = useI18n();
  const send = useSendTenantMessage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    try {
      await send.mutateAsync({ tenantId, subject, body, attachment });
      toast.success(t("portal.messages.sent"));
      setSubject("");
      setBody("");
      setAttachment(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("portal.messages.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor="message-subject">{t("portal.messages.subject")}</Label>
            <Input
              id="message-subject"
              className="pointer-coarse:min-h-11"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label required htmlFor="message-body">
              {t("portal.messages.body")}
            </Label>
            <Textarea
              id="message-body"
              className="pointer-coarse:min-h-11"
              rows={4}
              required
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="message-attachment">{t("portal.messages.attachment")}</Label>
            <Input
              id="message-attachment"
              ref={fileRef}
              type="file"
              accept="image/*,.pdf"
              className="pointer-coarse:min-h-11"
              onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              className="pointer-coarse:min-h-11"
              disabled={send.isPending || !body.trim()}
            >
              <Send className="size-4" />
              {send.isPending ? t("common.loading") : t("portal.messages.send")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
