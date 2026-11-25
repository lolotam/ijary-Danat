import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

export interface WizardStep {
  key: string;
  label: string;
}

/**
 * Dumb presentational stepper shell.
 *
 * Knows nothing about forms, close-outs, or validation — same division as
 * CsvImportDialog (parent owns state; this only renders chrome + nav).
 *
 * Deliberately NOT Tabs (implies free peer navigation; later steps are
 * invalid until earlier ones complete) and NOT Accordion (invites two
 * panels open at once).
 */
export function WizardShell({
  steps,
  current,
  onBack,
  onNext,
  nextLabel,
  nextDisabled = false,
  busy = false,
  children,
}: {
  steps: WizardStep[];
  current: number;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const isFirst = current <= 0;
  const isLast = current >= steps.length - 1;

  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap gap-2" aria-label={t("closeout.stepsAria")}>
        {steps.map((step, index) => {
          const active = index === current;
          const done = index < current;
          return (
            <li
              key={step.key}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                active && "border-primary bg-primary/10 font-medium text-primary",
                done && !active && "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
                !done && !active && "border-border text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  active && "bg-primary text-primary-foreground",
                  done && !active && "bg-muted-foreground/20",
                  !done && !active && "bg-muted",
                )}
              >
                {index + 1}
              </span>
              <span className="truncate">{step.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">{children}</div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={onBack} disabled={isFirst || busy}>
          {t("common.back")}
        </Button>
        <Button type="button" onClick={onNext} disabled={nextDisabled || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {nextLabel ?? (isLast ? t("common.confirm") : t("common.next"))}
        </Button>
      </div>
    </div>
  );
}
