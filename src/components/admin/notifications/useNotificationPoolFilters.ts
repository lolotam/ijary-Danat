import { useState } from "react";

import type {
  NotificationAudience,
  NotificationChannel,
  NotificationState,
  NotificationType,
} from "@/integrations/supabase/database.types";

/**
 * يحتفظ بحالة مرشّحات سجل الإشعارات (البحث، النوع، القناة، الحالة، الفترة، المرسل والمستلم).
 *
 * Lives in the page rather than inside the filter bar because the page also
 * feeds these values to `useNotifications` and to the selection-reset effect,
 * and the pool tab's badge count must keep querying while another tab is open.
 */
export function useNotificationPoolFilters() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<NotificationType | "all">("all");
  const [channel, setChannel] = useState<NotificationChannel | "all">("all");
  const [state, setState] = useState<NotificationState | "all">("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [audience, setAudience] = useState<NotificationAudience | "all">("all");
  const [recipient, setRecipient] = useState("");
  const [sender, setSender] = useState("");
  return {
    search,
    setSearch,
    type,
    setType,
    channel,
    setChannel,
    state,
    setState,
    from,
    setFrom,
    to,
    setTo,
    audience,
    setAudience,
    recipient,
    setRecipient,
    sender,
    setSender,
  };
}

export type NotificationPoolFilterState = ReturnType<typeof useNotificationPoolFilters>;
