import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { resolveTemplateVariables, type FinalMessage } from "@/fns/resolveTemplateVariables";
import type { LocaleCode } from "@/integrations/supabase/database.types";
import { FREE_TEXT_VARIABLES } from "@/lib/templateVariables";

/**
 * نصّ اصطناعي يذكر كل المتغيّرات، لإجبار المُحلّل على إعادتها جميعًا.
 *
 * The resolver is placeholder-driven, so asking for values without naming them
 * would return an empty map. Built from the catalogue rather than hand-written
 * so a variable added there cannot be silently missing from the chip row.
 */
const ALL_FREE_TEXT_PLACEHOLDERS = FREE_TEXT_VARIABLES.map((spec) => `{{${spec.key}}}`).join(" ");

/**
 * يجلب القيم الحيّة للمتغيّرات المتاحة لمستأجر وعقد محدّدين.
 *
 * Calls the same server function the preview panel calls, with `templateCode`
 * null so `buildFinalMessage` takes its free-text branch. Sharing the resolver
 * rather than re-deriving values is what keeps the chips honest: a chip can
 * never advertise a value the send would not substitute.
 *
 * `body` names every free-text key so the lazy resolver returns all of them —
 * the chip row has to show what is *available*, which is a different question
 * from what the half-written message currently references.
 */
export function useMessageVariables(input: {
  tenantId: string;
  contractId: string | null;
  locale: LocaleCode;
  enabled: boolean;
}) {
  const resolveFn = useServerFn(resolveTemplateVariables);

  const query = useQuery({
    queryKey: ["messageVariables", input.tenantId, input.contractId, input.locale],
    enabled: input.enabled && Boolean(input.tenantId),
    queryFn: () =>
      resolveFn({
        data: {
          tenantId: input.tenantId,
          templateCode: null,
          locale: input.locale,
          contractId: input.contractId,
          body: ALL_FREE_TEXT_PLACEHOLDERS,
        },
      }),
  });

  return {
    values: ((query.data as FinalMessage | undefined)?.variables ?? {}) as Record<string, string>,
    isLoading: query.isLoading,
  };
}
