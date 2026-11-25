import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type LandingPageSection, useUpdateLandingSection } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

interface SectionsPanelProps {
  sections: LandingPageSection[] | undefined;
}

/**
 * لوحة أقسام صفحة الهبوط: تفعيل كل قسم وعدد البطاقات في الصف.
 *
 * Extracted from the landing-page settings route (audit M13, plan row 6.7)
 * unchanged in behaviour; the route still loads the sections so its single
 * loading gate covers every tab exactly as before.
 */
export function SectionsPanel({ sections }: SectionsPanelProps) {
  const { t } = useI18n();
  const updateSection = useUpdateLandingSection();

  // Handles updating general section switch
  const handleToggleSection = async (id: string, enabled: boolean) => {
    try {
      await updateSection.mutateAsync({ id, updates: { enabled } });
      toast.success(t("landingSettings.sectionStatusUpdated"));
    } catch (e) {
      toast.error(t("landingSettings.anErrorOccurred"));
    }
  };

  const handleSectionColumns = async (
    section: { id: string; settings_json: unknown },
    columns: number,
  ) => {
    const cols = Math.min(8, Math.max(2, Math.round(columns)));
    const prev =
      section.settings_json &&
      typeof section.settings_json === "object" &&
      !Array.isArray(section.settings_json)
        ? (section.settings_json as Record<string, unknown>)
        : {};
    try {
      await updateSection.mutateAsync({
        id: section.id,
        updates: { settings_json: { ...prev, columns_per_row: cols } },
      });
      toast.success(t("landingSettings.cardsPerRowSaved"));
    } catch {
      toast.error(t("landingSettings.anErrorOccurred"));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("landingSettings.pageSections")}</CardTitle>
        <CardDescription>{t("landingSettings.enableOrDisableSectionsAppearing")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sections?.map((sec) => {
          const layoutKeys = ["shop_explorer", "gallery"];
          const showColumns = layoutKeys.includes(sec.section_key);
          const currentCols = Number(
            (sec.settings_json as { columns_per_row?: number } | null)?.columns_per_row,
          );
          const colsValue = Number.isFinite(currentCols)
            ? Math.min(8, Math.max(2, currentCols))
            : 6;
          return (
            <div
              key={sec.id}
              className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-semibold capitalize">{sec.section_key.replaceAll("_", " ")}</p>
                <p className="text-xs text-muted-foreground">Theme: {sec.theme || "dark"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                {showColumns ? (
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor={`cols-${sec.id}`}
                      className="whitespace-nowrap text-xs text-muted-foreground"
                    >
                      {t("landingSettings.cardsRow")}
                    </Label>
                    <Input
                      id={`cols-${sec.id}`}
                      type="number"
                      min={2}
                      max={8}
                      className="h-9 w-20"
                      defaultValue={colsValue}
                      key={`${sec.id}-${colsValue}`}
                      onBlur={(e) => {
                        const next = Number(e.target.value);
                        if (!Number.isFinite(next) || next === colsValue) return;
                        void handleSectionColumns(sec, next);
                      }}
                    />
                  </div>
                ) : null}
                <Switch
                  checked={sec.enabled}
                  onCheckedChange={(val) => handleToggleSection(sec.id, val)}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
