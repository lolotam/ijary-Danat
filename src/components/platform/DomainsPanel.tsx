import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import {
  addPlatformCustomDomain,
  fetchPlatformCompanyDomains,
  verifyPlatformCustomDomain,
  type PlatformCompanyDomain,
} from "@/platform/domains";
import { platformErrorMessage } from "@/platform/platformFns";

/**
 * رموز رفض عمليات النطاقات، وكل رمز يقابله جملة مترجمة.
 *
 * The server refuses with a bare code, so the panel turns it into a sentence
 * the super admin reads; anything else is a real failure and gets the generic
 * sentence instead of a raw key.
 */
const ERROR_KEYS: Record<string, string> = {
  DOMAIN_INVALID: "platformDomains.error.invalid",
  DOMAIN_RESERVED: "platformDomains.error.reserved",
  DOMAIN_TAKEN: "platformDomains.error.taken",
  DOMAIN_NOT_FOUND: "platformDomains.error.notFound",
  DOMAIN_NOT_CLOUDFLARE: "platformDomains.error.notCloudflare",
};

/**
 * يحوّل رفض العملية إلى جملة مترجمة.
 */
function domainErrorMessage(t: (key: string) => string, cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  const key = ERROR_KEYS[code];
  if (key) return t(key);
  return platformErrorMessage(t, cause);
}

/**
 * لوحة نطاقات شركة: عنوانها التلقائي، ونطاقها المخصّص، وحالة التحقق لكل منهما.
 *
 * Adding a domain asks the provider for it first, so the row appears only
 * once Cloudflare accepted the name; the ownership record then tells the
 * company what to publish in DNS, and the verify button re-reads the provider's
 * answer.
 */
export function DomainsPanel({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [domains, setDomains] = useState<PlatformCompanyDomain[]>([]);
  const [host, setHost] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** يقرأ نطاقات الشركة ويملأ اللوحة بها. */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDomains(await fetchPlatformCompanyDomains({ companyId }));
      setError(null);
    } catch (cause) {
      console.error("[platform/domains] Failed to load domains:", cause);
      setError(domainErrorMessage(t, cause));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * يضيف نطاقاً مخصّصاً بعد التحقق من شكله.
   */
  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const trimmed = host.trim();
    if (!trimmed) {
      setError(t("platformDomains.error.invalid"));
      return;
    }

    setBusy(true);
    try {
      const added = await addPlatformCustomDomain({ companyId, host: trimmed });
      setDomains((current) => [...current, added]);
      setHost("");
      setNotice(t("platformDomains.added"));
    } catch (cause) {
      console.error("[platform/domains] Failed to add the domain:", cause);
      setError(domainErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * يقرأ حالة النطاق من المزوّد ويحدّث الصف في اللوحة.
   */
  async function handleVerify(domainId: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const verified = await verifyPlatformCustomDomain({ domainId });
      setDomains((current) =>
        current.map((domain) => (domain.id === verified.id ? verified : domain)),
      );
      setNotice(
        verified.verificationStatus === "verified"
          ? t("platformDomains.verified")
          : t("platformDomains.verifyFailed"),
      );
    } catch (cause) {
      console.error("[platform/domains] Failed to verify the domain:", cause);
      setError(domainErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{t("platformDomains.title")}</h2>

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {!loading && domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("platformDomains.empty")}</p>
      ) : null}

      <ul className="space-y-3">
        {domains.map((domain) => (
          <li key={domain.id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span dir="ltr" className="font-mono text-sm">
                {domain.host}
              </span>
              <div className="flex items-center gap-2">
                <Badge variant={domain.kind === "custom" ? "info" : "secondary"}>
                  {domain.kind === "custom"
                    ? t("platformDomains.kind.custom")
                    : t("platformDomains.kind.subdomain")}
                </Badge>
                <Badge
                  variant={
                    domain.verificationStatus === "verified"
                      ? "success"
                      : domain.verificationStatus === "failed"
                        ? "destructive"
                        : "warning"
                  }
                >
                  {t(`platformDomains.status.${domain.verificationStatus}`)}
                </Badge>
              </div>
            </div>

            {domain.verificationRecords?.txt ? (
              <p dir="ltr" className="font-mono text-xs text-muted-foreground">
                {domain.verificationRecords.txt.name} = {domain.verificationRecords.txt.value}
              </p>
            ) : null}

            {domain.kind === "custom" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void handleVerify(domain.id)}
              >
                {t("platformDomains.verify")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      <form className="grid gap-3" onSubmit={(event) => void handleAdd(event)}>
        <Label htmlFor="platform-domain-host">{t("platformDomains.hostLabel")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="platform-domain-host"
            dir="ltr"
            placeholder={t("platformDomains.hostPlaceholder")}
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {t("platformDomains.add")}
          </Button>
        </div>
      </form>
    </section>
  );
}
