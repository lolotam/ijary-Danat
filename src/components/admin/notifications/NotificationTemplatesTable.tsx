import { Pencil, Trash2 } from "lucide-react";

import { SortableHead, useTableSort } from "@/components/admin/SortableTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { notificationTemplateSortValue } from "@/lib/adminTableSortValues";
import { workflowsUsingTemplate } from "@/lib/workflowTemplates";

/**
 * يسمّي سير العمل التي ترسل هذا القالب، أو «—» إن لم يربطه أي سير.
 *
 * A registry row supplies the localized name; a key with no row still shows
 * the key so the column does not go blank when the jobs query has not loaded.
 */
function usedByLabel(code: string, workflowNames: ReadonlyMap<string, string>): string {
  const keys = workflowsUsingTemplate(code);
  if (!keys.length) return "—";
  return keys.map((key) => workflowNames.get(key) ?? key).join(", ");
}

/**
 * جدول قوالب الإشعارات في شاشة الأتمتة — رأس كل عمود بيانات قابل للترتيب.
 */
export function NotificationTemplatesTable({
  templates,
  onEdit,
  onDelete,
  workflowNames = new Map(),
}: {
  templates: Tables<"notification_templates">[];
  onEdit: (template: Tables<"notification_templates">) => void;
  onDelete: (template: Tables<"notification_templates">) => void;
  workflowNames?: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  const {
    sort,
    toggle,
    sorted: sortedTemplates,
  } = useTableSort(templates, notificationTemplateSortValue);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <SortableHead sortKey="code" sort={sort} toggle={toggle}>
            {t("common.code")}
          </SortableHead>
          <SortableHead sortKey="type" sort={sort} toggle={toggle}>
            {t("common.type")}
          </SortableHead>
          <SortableHead sortKey="channel" sort={sort} toggle={toggle}>
            {t("notifications.channel")}
          </SortableHead>
          <SortableHead sortKey="is_active" sort={sort} toggle={toggle}>
            {t("reports.active")}
          </SortableHead>
          <TableHead>{t("workflows.usedBy")}</TableHead>
          <TableHead>{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedTemplates.map((template, index) => (
          <TableRow key={template.id}>
            <TableCell>{index + 1}</TableCell>
            <TableCell className="font-mono">{template.code}</TableCell>
            <TableCell>{t(`notificationType.${template.type}`)}</TableCell>
            <TableCell>{t(`notificationChannel.${template.channel}`)}</TableCell>
            <TableCell>
              <Badge variant={template.is_active ? "default" : "secondary"}>
                {template.is_active ? t("common.yes") : t("common.no")}
              </Badge>
            </TableCell>
            <TableCell>{usedByLabel(template.code, workflowNames)}</TableCell>
            <TableCell>
              <Button
                title={t("common.edit")}
                aria-label={t("common.edit")}
                size="icon"
                variant="ghost"
                className="pointer-coarse:size-11"
                onClick={() => onEdit(template)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                title={t("common.delete")}
                aria-label={t("common.delete")}
                size="icon"
                variant="ghost"
                className="text-destructive pointer-coarse:size-11"
                onClick={() => onDelete(template)}
              >
                <Trash2 className="size-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
