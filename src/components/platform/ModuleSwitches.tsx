import { useEffect, useState } from "react";

import { MODULE_KEYS, type ModuleKey } from "@/company/modules";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";
import {
  fetchPlatformModules,
  platformErrorMessage,
  setPlatformModules,
} from "@/platform/platformFns";
import type { PlatformModuleMap } from "@/platform/modules";

/**
 * لوحة مفاتيح أقسام شركة واحدة، مع حفظ بعد نافذة تأكيد.
 *
 * The switches are a draft until they are saved: a super admin who opens one
 * switch by mistake must be able to close the panel without changing the
 * company's navigation.
 */
export function ModuleSwitches({ companyId }: { companyId: string }) {
  const { t } = useI18n();
  const [savedMap, setSavedMap] = useState<PlatformModuleMap | null>(null);
  const [draft, setDraft] = useState<PlatformModuleMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchPlatformModules({ companyId })
      .then((loaded) => {
        if (mounted) {
          setSavedMap(loaded);
          setDraft(loaded);
          setLoadError(null);
        }
      })
      .catch((cause: unknown) => {
        if (mounted) setLoadError(platformErrorMessage(t, cause));
      });
    return () => {
      mounted = false;
    };
  }, [companyId, t]);

  /** يبدّل قيمة قسم واحد في المسوّدة، لا في الحالة المحفوظة. */
  function toggleModule(key: ModuleKey, enabled: boolean) {
    setDraft((current) => (current ? { ...current, [key]: enabled } : current));
    setSaveError(null);
    setSaved(false);
  }

  /** يحفظ الأقسام التي اختلفت عن الحالة المحفوظة بعد تأكيد المشرف العام. */
  async function handleConfirm() {
    if (!savedMap || !draft) return;
    const changes = MODULE_KEYS.filter((key) => savedMap[key] !== draft[key]).map((key) => ({
      key,
      enabled: draft[key],
    }));
    if (changes.length === 0) {
      setConfirmOpen(false);
      return;
    }

    setBusy(true);
    setSaveError(null);
    try {
      const result = await setPlatformModules({ companyId, modules: changes });
      setSavedMap(result);
      setDraft(result);
      setSaved(true);
      setConfirmOpen(false);
    } catch (cause) {
      setSaveError(platformErrorMessage(t, cause));
    } finally {
      setBusy(false);
    }
  }

  const hasChanges = Boolean(
    savedMap && draft && MODULE_KEYS.some((key) => savedMap[key] !== draft[key]),
  );

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">{t("platformBilling.modules.title")}</h2>

      {loadError ? (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      ) : null}

      {savedMap && draft ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {MODULE_KEYS.map((key) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <Label htmlFor={`platform-module-${key}`}>{t(`platformBilling.module.${key}`)}</Label>
              <Switch
                id={`platform-module-${key}`}
                checked={draft[key]}
                onCheckedChange={(enabled) => toggleModule(key, enabled)}
              />
            </div>
          ))}
        </div>
      ) : null}

      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("platformBilling.modules.saved")}
        </p>
      ) : null}
      {!hasChanges ? (
        <p className="text-xs text-muted-foreground">{t("platformBilling.modules.noChanges")}</p>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          <Button type="button" disabled={!hasChanges || busy}>
            {t("platformBilling.modules.save")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("platformBilling.modules.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("platformBilling.modules.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline" disabled={busy}>
                {t("common.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button type="button" onClick={() => void handleConfirm()} disabled={busy}>
              {busy ? t("common.loading") : t("platformBilling.modules.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
