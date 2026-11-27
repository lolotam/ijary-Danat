import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { companyFailedJobs, retryJob, type FailedJob } from "@/fns/companyJobs";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { formatPaymentDateTime, type DateTextDir } from "@/lib/dateDisplay";
import { PERMISSIONS } from "@/lib/permissions";
import { describeError } from "@/lib/toastError";

/** مفتاح استعلام المهام الفاشلة؛ إبطال واحد يحدّث البطاقة. */
const FAILED_JOBS_QUERY_KEY = ["company-failed-jobs"] as const;

/**
 * يعرض اسم نوع المهمة مترجماً، ويعرض الاسم الخام إن لم تكن له ترجمة.
 *
 * A kind this build does not know still has to be readable, so the raw name
 * is the fallback rather than a missing-key string.
 */
function jobKindLabel(kind: string, t: (key: string) => string): string {
  const key = `jobKind.${kind}`;
  const translated = t(key);
  return translated === key ? kind : translated;
}

/**
 * ينسّق وقت فشل المهمة بتاريخ التطبيق وساعته.
 *
 * The app's own display rules come from `dateDisplay`, so the card reads like
 * every other date on the screen instead of carrying a second format.
 */
function formatFailedAt(iso: string, dir: DateTextDir): string {
  return formatPaymentDateTime(iso, iso, dir);
}

/**
 * صف مهمة فاشلة: نوعها وسبب فشلها ووقت فشلها وزرّ إعادة المحاولة.
 */
function FailedJobRow({
  job,
  retrying,
  onRetry,
}: {
  job: FailedJob;
  /** إعادة المحاولة جارية لهذا الصف: زرّه معطّل حتى تنتهي. */
  retrying: boolean;
  onRetry: (id: string) => void;
}) {
  const { t, dir } = useI18n();

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/70 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{jobKindLabel(job.kind, t)}</Badge>
          <span className="text-xs text-muted-foreground">
            {t("settings.failedJobs.attempts")}: {job.attempts}
          </span>
        </div>
        {job.lastError ? (
          <p className="text-sm text-destructive">
            <span className="text-muted-foreground">{t("settings.failedJobs.reason")}: </span>
            {/* The reason is the worker's own English message; its own
                direction keeps its punctuation where the reader expects it. */}
            <span dir="ltr">{job.lastError}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.failedJobs.noReason")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("settings.failedJobs.failedAt")}:{" "}
          {formatFailedAt(job.finishedAt ?? job.createdAt, dir)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={retrying}
        onClick={() => onRetry(job.id)}
      >
        <RotateCcw className="size-4" />
        {t("settings.failedJobs.retry")}
      </Button>
    </div>
  );
}

/**
 * بطاقة المهام الخلفية الفاشلة: ما فشلت، ولماذا، وزرّ يعيد تشغيلها.
 *
 * The card is only rendered for a holder of the company-settings permission,
 * and the server function refuses the same permission, so the screen and the
 * data agree on who may see a failed job.
 */
export function FailedJobsCard() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const canManageJobs = permissions.can(PERMISSIONS.COMPANY_UPDATE);

  const jobsQuery = useQuery({
    queryKey: FAILED_JOBS_QUERY_KEY,
    enabled: canManageJobs,
    queryFn: (): Promise<FailedJob[]> => companyFailedJobs(),
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => retryJob({ data: { id } }),
    onSuccess: () => {
      toast.success(t("settings.failedJobs.retrySuccess"));
      // The retried row leaves the failed list, so the card has to ask again.
      void queryClient.invalidateQueries({ queryKey: FAILED_JOBS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(t("settings.failedJobs.retryError"), { description: describeError(error) });
    },
  });

  if (!canManageJobs) return null;

  const jobs = jobsQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.failedJobs.title")}</CardTitle>
        <CardDescription>{t("settings.failedJobs.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {jobsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : null}
        {jobsQuery.error ? <p className="text-sm text-destructive">{t("common.error")}</p> : null}
        {!jobsQuery.isLoading && !jobsQuery.error && jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.failedJobs.empty")}</p>
        ) : null}
        {jobs.map((job) => (
          <FailedJobRow
            key={job.id}
            job={job}
            retrying={retryMutation.isPending && retryMutation.variables === job.id}
            onRetry={(id) => retryMutation.mutate(id)}
          />
        ))}
      </CardContent>
    </Card>
  );
}
