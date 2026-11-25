import { LayoutGrid, Sparkles } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import type { InvoicesLayoutTheme } from "@/hooks/useInvoicesLayoutTheme";

interface InvoicesThemeSelectorProps {
  theme: InvoicesLayoutTheme;
  onChange: (theme: InvoicesLayoutTheme) => void;
}

/**
 * قائمة اختيار مظهر صفحة الفواتير: تتيح التبديل الفوري بين السمة الحديثة والكلاسيكية.
 *
 * Provides a dedicated theme/layout switcher allowing property admins to
 * toggle seamlessly between the executive modern dashboard and the classic minimalist view.
 */
export function InvoicesThemeSelector({ theme, onChange }: InvoicesThemeSelectorProps) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2">
      <Select value={theme} onValueChange={(val) => onChange(val as InvoicesLayoutTheme)}>
        <SelectTrigger
          className="h-9 w-44 rounded-xl text-xs font-semibold"
          aria-label={t("invoices.themeLabel")}
        >
          <div className="flex items-center gap-1.5 truncate">
            {theme === "modern" ? (
              <Sparkles className="size-3.5 text-emerald-500 shrink-0" />
            ) : (
              <LayoutGrid className="size-3.5 text-muted-foreground shrink-0" />
            )}
            <SelectValue placeholder={t("invoices.themeLabel")} />
          </div>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="modern" className="text-xs font-semibold">
            <div className="flex items-center gap-2">
              <Sparkles className="size-3.5 text-emerald-500" />
              <span>{t("invoices.themeModern")}</span>
            </div>
          </SelectItem>
          <SelectItem value="classic" className="text-xs font-semibold">
            <div className="flex items-center gap-2">
              <LayoutGrid className="size-3.5 text-muted-foreground" />
              <span>{t("invoices.themeClassic")}</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
