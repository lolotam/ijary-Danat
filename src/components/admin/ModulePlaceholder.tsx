import { useI18n } from "@/i18n/provider";

interface Props {
  titleKey: string;
  phase?: string;
}

export function ModulePlaceholder({ titleKey, phase }: Props) {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-xl border bg-card p-8 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary text-lg font-semibold">
          ⚙
        </div>
        <h1 className="mt-4 text-2xl font-bold">{t(titleKey)}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("admin.moduleTitle")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("admin.moduleBody")}</p>
        {phase && (
          <span className="mt-4 inline-block rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground">
            {t("admin.phase")}: {phase}
          </span>
        )}
      </div>
    </div>
  );
}
