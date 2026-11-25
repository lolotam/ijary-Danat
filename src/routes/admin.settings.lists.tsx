import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { ExpenseCategoriesPanel } from "@/components/admin/settings/ExpenseCategoriesPanel";
import { ListItemsPanel } from "@/components/admin/settings/ListItemsPanel";
import { Toaster } from "@/components/ui/sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useOptionLists, type OptionList } from "@/hooks/useOptionLists";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";
import { useI18n } from "@/i18n/provider";

export const Route = createFileRoute("/admin/settings/lists")({ component: ListsPage });

function ListsPage() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const lists = useOptionLists();
  const [selectedListId, setSelectedListId] = useState<string | null>(null);

  // expense_categories is a real table behind its own RLS code
  // (expenses.categories, migration 230); showing it to a role with only
  // settings.lists would offer edits that every save refuses.
  const visibleLists = permissions.can(PERMISSIONS.EXPENSES_CATEGORIES)
    ? lists.data
    : lists.data?.filter((list) => list.code !== "expense_categories");
  const selectedList = visibleLists?.find((list) => list.id === selectedListId) ?? null;

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.SETTINGS_LISTS)) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader title={t("lists.title")} subtitle={t("lists.subtitle")} />
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("lists.catalogTitle")}</CardTitle>
            <CardDescription>{t("lists.catalogSubtitle")}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[540px] overflow-y-auto">
              {visibleLists?.map((list, index) => (
                <ListButton
                  key={list.id}
                  list={list}
                  index={index}
                  active={list.id === selectedListId}
                  onSelect={() => setSelectedListId(list.id)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
        <div className="min-w-0">
          {selectedList ? (
            selectedList.code === "expense_categories" ? (
              <ExpenseCategoriesPanel list={selectedList} />
            ) : (
              <ListItemsPanel list={selectedList} />
            )
          ) : (
            <Card className="flex h-full items-center justify-center p-10 text-muted-foreground">
              {t("lists.selectCatalog")}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ListButton({
  list,
  index,
  active,
  onSelect,
}: {
  list: OptionList;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { locale } = useI18n();
  const label = locale === "ar" ? list.name_ar : list.name_en;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-2 border-b px-4 py-3 text-start text-sm transition-colors hover:bg-muted ${active ? "bg-muted font-medium" : ""}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}.</span>
        <span className="truncate">{label}</span>
      </span>
      <code className="text-[10px] text-muted-foreground">{list.code}</code>
    </button>
  );
}
