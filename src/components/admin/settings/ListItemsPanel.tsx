import { useState } from "react";
import { Plus, Pencil, Trash2, Save, X } from "lucide-react";
import { toast } from "sonner";

import { TableState } from "@/components/admin/Phase2Ui";
import { Badge } from "@/components/ui/badge";
import { optionItemTone } from "@/lib/statusTone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useCreateOptionListItem,
  useDeleteOptionListItem,
  useOptionListItems,
  type OptionList,
  type OptionListItem,
} from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";
import { enumMembersForList, validateOptionListItemValue } from "@/lib/enumBackedOptionLists";
import { valueRenameLock } from "@/lib/optionListRenameRules";
import { emptyDraft, type ItemDraft } from "./listItemDraft";
import { RenameValueDialog } from "./RenameValueDialog";
import { useListValueRenameFlow } from "./useListValueRenameFlow";

const LOCK_TOOLTIP_KEY = {
  refusedList: "lists.valueRenameRefusedList",
  codeBound: "lists.valueCodeBound",
} as const;

/**
 * يعرض عناصر قائمة خيارات واحدة ويتيح إضافتها وتعديلها وحذفها.
 */
export function ListItemsPanel({ list }: { list: OptionList }) {
  const { t } = useI18n();
  const items = useOptionListItems(list.id);
  const createItem = useCreateOptionListItem();
  const deleteItem = useDeleteOptionListItem();
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft);
  const [showAdd, setShowAdd] = useState(false);
  const enumMembers = enumMembersForList(list.code);

  function enumValueError(value: string): string | null {
    const result = validateOptionListItemValue(list.code, value);
    if (result.ok) return null;
    // Explains WHY: this list drives a fixed enum column; only members store.
    return t("lists.enumValueInvalid").replace("{values}", result.allowed.join(", "));
  }

  const flow = useListValueRenameFlow({
    refetchItems: () => items.refetch(),
    validateValue: enumValueError,
  });
  const { editing } = flow;

  async function saveNew() {
    if (!draft.value.trim() || !draft.label_ar.trim() || !draft.label_en.trim()) {
      toast.error(t("lists.validationRequired"));
      return;
    }
    const enumError = enumValueError(draft.value);
    if (enumError) {
      toast.error(enumError);
      return;
    }
    try {
      await createItem.mutateAsync({
        list_id: list.id,
        value: draft.value.trim(),
        label_ar: draft.label_ar.trim(),
        label_en: draft.label_en.trim(),
        sort_order: draft.sort_order,
        is_active: draft.is_active,
      });
      toast.success(t("phase2.saved"));
      setDraft(emptyDraft);
      setShowAdd(false);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  async function remove(item: OptionListItem) {
    // Seeded rows delete like any other (migration 61), but they are the ones
    // wired into dropdowns elsewhere in the app, so the confirmation says what
    // disappears rather than letting the row vanish silently.
    const message = item.is_system
      ? `${t("lists.systemDeleteWarning")}\n\n${t("phase2.deleteDescription")}`
      : t("phase2.deleteDescription");
    if (!confirm(message)) return;
    try {
      await deleteItem.mutateAsync(item);
      toast.success(t("phase2.deleted"));
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">{list.name_ar}</CardTitle>
          <CardDescription>{list.name_en}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          <Plus className="size-4" /> {t("lists.addItem")}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {showAdd && (
          <div className="grid gap-3 border-b bg-muted/30 p-4 sm:grid-cols-5">
            <div>
              <Label required className="text-xs">
                {t("lists.value")}
              </Label>
              {enumMembers ? (
                <Select
                  value={draft.value || undefined}
                  onValueChange={(value) => setDraft((d) => ({ ...d, value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("lists.value")} />
                  </SelectTrigger>
                  <SelectContent>
                    {enumMembers.map((member) => (
                      <SelectItem key={member} value={member}>
                        {member}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={draft.value}
                  onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                />
              )}
            </div>
            <div>
              <Label required className="text-xs">
                {t("common.nameAr")}
              </Label>
              <Input
                value={draft.label_ar}
                onChange={(e) => setDraft((d) => ({ ...d, label_ar: e.target.value }))}
              />
            </div>
            <div>
              <Label required className="text-xs">
                {t("common.nameEn")}
              </Label>
              <Input
                value={draft.label_en}
                onChange={(e) => setDraft((d) => ({ ...d, label_en: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">{t("lists.sortOrder")}</Label>
              <Input
                type="number"
                value={draft.sort_order}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, sort_order: Number(e.target.value) || 0 }))
                }
              />
            </div>
            <div className="flex items-end gap-2">
              <Button size="sm" onClick={saveNew} disabled={createItem.isPending}>
                <Save className="size-4" /> {t("common.save")}
              </Button>
              <Button
                title={t("common.cancel")}
                aria-label={t("common.cancel")}
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(emptyDraft);
                  setShowAdd(false);
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
        )}
        <TableState
          loading={items.isLoading}
          error={Boolean(items.error)}
          empty={!items.data?.length}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t("lists.value")}</TableHead>
                <TableHead>{t("common.nameAr")}</TableHead>
                <TableHead>{t("common.nameEn")}</TableHead>
                <TableHead>{t("lists.sortOrder")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.data?.map((item, index) => {
                const isEditing = editing?.item.id === item.id;
                const lock = isEditing ? valueRenameLock(list.code, editing.originalValue) : null;
                return (
                  <TableRow key={item.id}>
                    <TableCell>{index + 1}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {isEditing ? (
                        /*
                         * The field is read-only for exactly the values the
                         * server refuses to rename (refused lists and values the
                         * code depends on), so no admin is offered a rename that
                         * can only fail after the preview; labels stay editable.
                         */
                        <Input
                          value={editing.item.value}
                          onChange={(e) => flow.updateEditing({ value: e.target.value })}
                          disabled={lock !== null}
                          title={lock ? t(LOCK_TOOLTIP_KEY[lock]) : undefined}
                        />
                      ) : (
                        <>
                          {list.code === "contract_statuses" ||
                          list.code === "contract_types" ||
                          list.code === "email_categories" ? (
                            <Badge variant={optionItemTone(item.value)}>{item.value}</Badge>
                          ) : (
                            item.value
                          )}
                          {item.is_system && (
                            <Badge className="ms-2" variant="outline">
                              {t("lists.system")}
                            </Badge>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          value={editing.item.label_ar}
                          onChange={(e) => flow.updateEditing({ label_ar: e.target.value })}
                        />
                      ) : (
                        item.label_ar
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          value={editing.item.label_en}
                          onChange={(e) => flow.updateEditing({ label_en: e.target.value })}
                        />
                      ) : (
                        item.label_en
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          type="number"
                          value={editing.item.sort_order}
                          onChange={(e) =>
                            flow.updateEditing({ sort_order: Number(e.target.value) || 0 })
                          }
                        />
                      ) : (
                        item.sort_order
                      )}
                    </TableCell>
                    <TableCell>
                      {isEditing ? (
                        <Switch
                          checked={editing.item.is_active}
                          onCheckedChange={(v) => flow.updateEditing({ is_active: v })}
                        />
                      ) : (
                        <Badge variant={item.is_active ? "default" : "secondary"}>
                          {item.is_active ? t("lists.active") : t("lists.inactive")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              onClick={flow.saveEdit}
                              disabled={flow.savePending}
                              title={t("common.save")}
                              aria-label={t("common.save")}
                            >
                              <Save className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={flow.cancelEdit}
                              title={t("common.cancel")}
                              aria-label={t("common.cancel")}
                            >
                              <X className="size-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => flow.startEdit(item)}
                              title={t("common.edit")}
                              aria-label={t("common.edit")}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            {/*
                              Seeded rows are deletable too (migration 61). The
                              badge marks provenance, not permission — `remove`
                              raises the warning instead of the button refusing.
                            */}
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => remove(item)}
                              title={t("common.delete")}
                              aria-label={t("common.delete")}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableState>
      </CardContent>
      <RenameValueDialog
        open={Boolean(flow.renamePreview)}
        oldValue={flow.renamePreview?.oldValue ?? ""}
        newValue={flow.renamePreview?.newValue ?? ""}
        counts={flow.renamePreview?.counts ?? null}
        pending={flow.renamePending}
        onConfirm={flow.confirmRename}
        onCancel={flow.cancelRename}
      />
    </Card>
  );
}
