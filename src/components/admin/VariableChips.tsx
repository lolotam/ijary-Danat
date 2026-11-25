import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { FREE_TEXT_VARIABLES } from "@/lib/templateVariables";

/**
 * يُدرج نصًا عند موضع المؤشّر ويعيد النص الجديد وموضع المؤشّر بعده.
 *
 * Pure and exported so the caret arithmetic is tested directly — the suite runs
 * in a node environment with no DOM, so a textarea cannot be driven in a test.
 */
export function insertAtCursor(
  value: string,
  token: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; caret: number } {
  return {
    text: value.slice(0, selectionStart) + token + value.slice(selectionEnd),
    caret: selectionStart + token.length,
  };
}

/**
 * صفّ أزرار المتغيّرات المتاحة، كل زر يعرض قيمته الحقيقية لهذا المستأجر.
 *
 * Values come from the same server function the preview and the send use, so
 * this row cannot drift from what is actually substituted. It replaces a
 * hand-written hint string that had drifted exactly that way: it advertised
 * {{months_until_expiry}}, removed as a defect by migration 58, and {{period}},
 * which no manual-send type resolves. Both reached tenants as literal braces.
 *
 * A variable with no value is disabled rather than hidden. An admin who expects
 * a balance needs to see that this tenant has none — not to wonder where the
 * button went.
 */
export function VariableChips({
  values,
  onInsert,
}: {
  values: Record<string, string>;
  onInsert: (token: string) => void;
}) {
  const { t, locale } = useI18n();

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t("notifications.variablesHelp")}</p>
      <div className="flex flex-wrap gap-1.5">
        {FREE_TEXT_VARIABLES.map((spec) => {
          const value = values[spec.key] ?? "";
          return (
            <Button
              key={spec.key}
              type="button"
              size="sm"
              variant="outline"
              disabled={!value}
              title={value || t("notifications.variableEmpty")}
              className="h-7 gap-1.5 text-xs font-normal"
              onClick={() => onInsert(`{{${spec.key}}}`)}
            >
              <span>{locale === "ar" ? spec.labelAr : spec.labelEn}</span>
              <span className="max-w-[10rem] truncate font-mono text-[10px] text-muted-foreground">
                {value || "∅"}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
