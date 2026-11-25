import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { TableState } from "@/components/admin/Phase2Ui";
import { CardField, MobileCardList } from "@/components/admin/MobileCardList";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGenerateSalaries, useSalaries, useSetSalaryDelivered } from "@/hooks/useEmployees";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";

/** تبويب الرواتب: توليد رواتب الشهر وتعليم كل راتب كمسلَّم. */
export function SalaryTab() {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const permissions = usePermissions();
  const canRead = permissions.can(PERMISSIONS.SALARIES_READ);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const salaries = useSalaries(year, month, canRead);
  const setDelivered = useSetSalaryDelivered();
  const generate = useGenerateSalaries();

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", { month: "long" }),
    [locale],
  );

  if (!canRead) {
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );
  }

  const years = Array.from({ length: 7 }, (_, index) => now.getFullYear() - 3 + index);
  const rows = salaries.data ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  const deliveredTotal = rows
    .filter((row) => row.delivered)
    .reduce((sum, row) => sum + Number(row.amount), 0);

  /** يولّد رواتب الشهر المختار. */
  async function runGenerate() {
    try {
      const created = await generate.mutateAsync({ year, month });
      toast.success(
        t("salaries.generated").replace(
          "{count}",
          String(Array.isArray(created) ? created.length : 0),
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="grid gap-1.5">
            <Label>{t("common.year")}</Label>
            <Select value={String(year)} onValueChange={(value) => setYear(Number(value))}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("common.month")}</Label>
            <Select value={String(month)} onValueChange={(value) => setMonth(Number(value))}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, index) => index + 1).map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {monthFormatter.format(new Date(2026, value - 1, 1))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {permissions.can(PERMISSIONS.SALARIES_CREATE) && (
          <Button variant="outline" disabled={generate.isPending} onClick={runGenerate}>
            <RefreshCw className="size-4" />
            {t("salaries.generate")}
          </Button>
        )}
      </div>

      {/* Pressing generate twice is harmless — the RPC is idempotent on
          (employee_id, year, month) — including after the `salaries` cron job,
          which also generates the month on the 1st in production. */}
      <p className="text-xs text-muted-foreground">{t("salaries.generateHint")}</p>

      <div className="flex flex-wrap gap-4 rounded-lg border p-3 text-sm">
        <span>
          {t("salaries.total")}:{" "}
          <LtrText className="font-medium">{formatAmount(total, locale)}</LtrText>
        </span>
        <span>
          {t("salaries.deliveredTotal")}:{" "}
          <LtrText className="font-medium">{formatAmount(deliveredTotal, locale)}</LtrText>
        </span>
      </div>

      <TableState loading={salaries.isLoading} error={salaries.isError} empty={!rows.length}>
        {isMobile ? (
          <MobileCardList
            items={rows}
            keyFor={(row) => row.id}
            renderCard={(row) => (
              <div className="space-y-2">
                <div className="font-medium">
                  {locale === "en"
                    ? (row.employee?.name_en ?? row.employee?.name)
                    : row.employee?.name}
                </div>
                <CardField label={t("salaries.amount")}>
                  <LtrText>{formatAmount(Number(row.amount), locale)}</LtrText>
                </CardField>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={row.delivered}
                    disabled={!permissions.can(PERMISSIONS.SALARIES_UPDATE)}
                    onCheckedChange={(checked) =>
                      setDelivered.mutate({ id: row.id, delivered: checked })
                    }
                  />
                  <Label>{t("salaries.delivered")}</Label>
                </div>
              </div>
            )}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.code")}</TableHead>
                <TableHead>{t("common.name")}</TableHead>
                <TableHead>{t("salaries.amount")}</TableHead>
                <TableHead>{t("salaries.delivered")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.employee?.code ?? "—"}</TableCell>
                  <TableCell className="font-medium">
                    {locale === "en"
                      ? (row.employee?.name_en ?? row.employee?.name)
                      : row.employee?.name}
                  </TableCell>
                  <TableCell>
                    <LtrText>{formatAmount(Number(row.amount), locale)}</LtrText>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={row.delivered}
                      disabled={!permissions.can(PERMISSIONS.SALARIES_UPDATE)}
                      onCheckedChange={(checked) =>
                        setDelivered.mutate({ id: row.id, delivered: checked })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableState>
    </div>
  );
}
