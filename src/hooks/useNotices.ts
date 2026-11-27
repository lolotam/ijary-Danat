import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { markNoticeRead, myNotices, type Notice } from "@/fns/notices";
import { supabase } from "@/integrations/supabase/client";

/** مفتاح الاستعلام: إبطال واحد يحدّث الجرس وكل ما يقرأ الإشعارات. */
const NOTICES_QUERY_KEY = ["notices"] as const;

/** فترة الاستطلاع الاحتياطية حين لا ينجح اشتراك Realtime. */
const POLL_INTERVAL_MS = 30_000;

/**
 * يجلب إشعارات الموظف ويبقيها محدّثة: اشتراك Realtime على الإدراج، مع استطلاع
 * كل ٣٠ ثانية إن تعذّر الاشتراك.
 *
 * Realtime يطبّق سياسات RLS نفسها، فلا يصل إشعارٌ لغير صاحبِه. وإن لم تشترك
 * القناة — خطأ من الخادم أو انقطاع — يتحوّل الاستعلام إلى استطلاع دوري حتى لا
 * يتجمّد الجرس على آخر حالة.
 */
export function useNotices(enabled = true) {
  const queryClient = useQueryClient();
  const [subscribed, setSubscribed] = useState(false);

  const query = useQuery({
    queryKey: NOTICES_QUERY_KEY,
    enabled,
    queryFn: (): Promise<Notice[]> => myNotices(),
    // The subscription carries the news; polling is the fallback for a channel
    // that never joined, so the two never run at once.
    refetchInterval: () => (subscribed ? false : POLL_INTERVAL_MS),
  });

  useEffect(() => {
    if (!enabled) return;

    const channel = supabase
      .channel("user-notices")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_notices" }, () => {
        void queryClient.invalidateQueries({ queryKey: NOTICES_QUERY_KEY });
      })
      .subscribe((status: string) => {
        setSubscribed(status === "SUBSCRIBED");
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, queryClient]);

  return query;
}

/**
 * يعلّم إشعاراً كمقروء ويحدّث القائمة.
 */
export function useMarkNoticeRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      await markNoticeRead({ data: { id } });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTICES_QUERY_KEY });
    },
  });
}
