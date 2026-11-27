import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { fetchPlatformCompanyUsers } from "@/platform/platformFns";
import {
  endPlatformSupportSession,
  listOpenSupportSessions,
  startPlatformSupportSession,
  supportSessionErrorMessage,
  type OpenSupportSession,
  type StartedSupportSession,
} from "@/platform/supportSessionFns";
import type { PlatformUserSummary } from "@/platform/users";

/** حقول نموذج بدء جلسة الدعم. */
interface SupportSessionForm {
  targetUserId: string;
  reason: string;
}

/**
 * لوحة جلسة الدعم الفني: اختيار موظف من الشركة، وكتابة سبب إلزامي، ثم عرض
 * رابط الدخول مرة واحدة، وإنهاء أي جلسة مفتوحة.
 *
 * The reason is required because the company sees it: the banner inside the
 * company panel names the platform admin and the reason, and the platform
 * audit log keeps both (FR-070, FR-071).
 */
export function SupportSessionPanel({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [staff, setStaff] = useState<PlatformUserSummary[]>([]);
  const [openSessions, setOpenSessions] = useState<OpenSupportSession[]>([]);
  const [form, setForm] = useState<SupportSessionForm>({ targetUserId: "", reason: "" });
  const [started, setStarted] = useState<StartedSupportSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [endingSessionId, setEndingSessionId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** يقرأ موظفي الشركة النشطين وجلساتها المفتوحة. */
  const load = useCallback(async () => {
    try {
      const [users, sessions] = await Promise.all([
        fetchPlatformCompanyUsers({ companyId }),
        listOpenSupportSessions({ companyId }),
      ]);
      setStaff(users.rows.filter((row) => row.isActive));
      setOpenSessions(sessions);
      setError(null);
    } catch (cause) {
      setError(supportSessionErrorMessage(t, cause));
    }
  }, [companyId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** يضع قيمة حقل واحد من نموذج بدء الجلسة. */
  function setField(field: keyof SupportSessionForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  /** يبدأ جلسة الدعم ويعرض رابط الدخول. */
  async function handleStart(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!form.targetUserId) {
      setError(t("supportSession.platform.error.targetRequired"));
      return;
    }
    if (!form.reason.trim()) {
      setError(t("supportSession.platform.error.reasonRequired"));
      return;
    }

    setStarting(true);
    try {
      const result = await startPlatformSupportSession({
        companyId,
        targetUserId: form.targetUserId,
        reason: form.reason.trim(),
      });
      setStarted(result);
      setCopied(false);
      setForm({ targetUserId: "", reason: "" });
      await load();
    } catch (cause) {
      setError(supportSessionErrorMessage(t, cause));
    } finally {
      setStarting(false);
    }
  }

  /** ينهي جلسة دعم مفتوحة. */
  async function handleEnd(sessionId: string) {
    setError(null);
    setEndingSessionId(sessionId);
    try {
      await endPlatformSupportSession({ sessionId });
      await load();
    } catch (cause) {
      setError(supportSessionErrorMessage(t, cause));
    } finally {
      setEndingSessionId(null);
    }
  }

  /** ينسخ رابط الدخول إلى حافظة المتصفح. */
  async function handleCopy() {
    if (!started) return;
    try {
      await navigator.clipboard.writeText(started.link);
      setCopied(true);
    } catch (cause) {
      setError(supportSessionErrorMessage(t, cause));
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{t("supportSession.platform.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("supportSession.platform.description")}</p>
      </header>

      <form className="grid gap-4" onSubmit={handleStart}>
        <div className="grid gap-1.5">
          <Label htmlFor="platform-support-target" required>
            {t("supportSession.platform.target")}
          </Label>
          <Select
            value={form.targetUserId}
            onValueChange={(value) => setField("targetUserId", value)}
          >
            <SelectTrigger id="platform-support-target">
              <SelectValue placeholder={t("supportSession.platform.targetHint")} />
            </SelectTrigger>
            <SelectContent>
              {staff.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.displayName ?? row.username ?? row.email ?? row.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="platform-support-reason" required>
            {t("supportSession.platform.reason")}
          </Label>
          <Textarea
            id="platform-support-reason"
            value={form.reason}
            maxLength={500}
            onChange={(event) => setField("reason", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("supportSession.platform.reasonHint")}</p>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={starting}>
            {starting ? t("supportSession.platform.starting") : t("supportSession.platform.start")}
          </Button>
        </div>
      </form>

      {started ? (
        <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium">{t("supportSession.platform.linkTitle")}</p>
          <code
            dir="ltr"
            className="block select-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
          >
            {started.link}
          </code>
          <p className="text-xs text-muted-foreground">{t("supportSession.platform.linkHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
              {t("supportSession.platform.copy")}
            </Button>
            {copied ? (
              <span role="status" className="text-xs text-muted-foreground">
                {t("supportSession.platform.copied")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("supportSession.platform.openSessions")}</h3>
        {openSessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("supportSession.platform.noOpenSessions")}
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {openSessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div>
                  <p className="font-medium">{session.reason}</p>
                  <p dir="ltr" className="text-xs text-muted-foreground">
                    {t("supportSession.platform.expiresAt")}: {session.expiresAt}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={endingSessionId !== null}
                  onClick={() => void handleEnd(session.id)}
                >
                  {endingSessionId === session.id
                    ? t("supportSession.platform.ending")
                    : t("supportSession.platform.end")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
