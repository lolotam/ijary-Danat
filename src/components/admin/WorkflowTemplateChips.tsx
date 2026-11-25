import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { templateCodesFor } from "@/lib/workflowTemplates";

type Template = Tables<"notification_templates">;

/**
 * يعرض قوالب سير العمل كشرائح؛ النقر على شريحة يفتح محرر القالب نفسه.
 *
 * A code with no DB row (deleted by an admin) renders muted and inert — the
 * sender falls back to its built-in copy, so it is information, not an error.
 */
export function WorkflowTemplateChips({
  workflowKey,
  templatesByCode,
  onEdit,
}: {
  workflowKey: string;
  templatesByCode: ReadonlyMap<string, Template>;
  onEdit?: (template: Template) => void;
}) {
  const { t } = useI18n();
  const codes = templateCodesFor(workflowKey);
  if (!codes.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {codes.map((code) => {
        const template = templatesByCode.get(code);
        if (!template || !onEdit) {
          return (
            <Badge
              key={code}
              variant="outline"
              className="font-mono text-muted-foreground"
              title={template ? undefined : t("workflows.templateMissing")}
            >
              {code}
            </Badge>
          );
        }
        return (
          <Button
            key={code}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 font-mono text-xs"
            aria-label={`${t("common.edit")} ${code}`}
            onClick={() => onEdit(template)}
          >
            {code}
            <Pencil className="size-3" />
          </Button>
        );
      })}
    </div>
  );
}
