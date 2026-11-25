export interface ItemDraft {
  value: string;
  label_ar: string;
  label_en: string;
  sort_order: number;
  is_active: boolean;
}

export const emptyDraft: ItemDraft = {
  value: "",
  label_ar: "",
  label_en: "",
  sort_order: 0,
  is_active: true,
};
