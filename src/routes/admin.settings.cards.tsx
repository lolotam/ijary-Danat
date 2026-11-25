import { createFileRoute } from "@tanstack/react-router";

import { ModuleHeader } from "@/components/admin/Phase2Ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useCardVisibility, useSetCardVisibility } from "@/hooks/useCardVisibility";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { CARD_PAGE_LABEL_KEYS, cardsByPage } from "@/lib/cardRegistry";
import { PERMISSIONS } from "@/lib/permissions";
import { showError } from "@/lib/toastError";

export const Route = createFileRoute("/admin/settings/cards")({
  component: CardsControlPage,
});

/**
 * شاشة التحكم في ظهور بطاقات المؤشرات لكل صفحات الإدارة.
 *
 * The list is CARD_REGISTRY grouped by page — this screen must not keep its
 * own card list, or a card could be toggled here and never gated on its page.
 */
export function CardsControlPage() {
  const { t } = useI18n();
  const permissions = usePermissions();
  const { isCardVisible, error } = useCardVisibility();
  const setVisibility = useSetCardVisibility();

  if (permissions.isLoading) return <p>{t("common.loading")}</p>;
  if (!permissions.can(PERMISSIONS.COMPANY_UPDATE)) {
    return <p className="text-destructive">{t("common.notAuthorized")}</p>;
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title={t("settings.cardsControl")}
        subtitle={t("settings.cardsControlSubtitle")}
      />
      {error ? <p className="text-sm text-destructive">{t("common.error")}</p> : null}
      {cardsByPage().map(({ page, cards }) => (
        <Card key={page}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t(CARD_PAGE_LABEL_KEYS[page])}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => {
              const inputId = `card-visibility-${card.id}`;
              return (
                <div key={card.id} className="flex items-center gap-2">
                  <Checkbox
                    id={inputId}
                    checked={isCardVisible(card.id)}
                    disabled={setVisibility.isPending}
                    onCheckedChange={(checked) => {
                      // onError, not a try/catch: react-query gives us one place
                      // to surface the failure, and a swallowed error here left
                      // the checkbox looking toggled while the row never wrote.
                      setVisibility.mutate(
                        { cardId: card.id, isVisible: checked === true },
                        {
                          onError: (error) => showError(t("common.error"), error),
                        },
                      );
                    }}
                  />
                  <Label htmlFor={inputId} className="cursor-pointer font-normal">
                    {t(card.labelKey)}
                  </Label>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
