import { useQuery } from "@tanstack/react-query";

import { resolveMapEmbed } from "@/fns/resolveMapEmbed";

/**
 * Resolves the company's Map URL setting into an embeddable src. Cached hard —
 * the answer only changes when an admin edits the setting, and resolving a
 * short link costs a redirect-following fetch on the server.
 */
export function useMapEmbed(mapUrl: string | null | undefined) {
  const url = mapUrl?.trim() || null;
  return useQuery({
    queryKey: ["map-embed", url],
    enabled: Boolean(url),
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
    queryFn: () => resolveMapEmbed({ data: { url: url! } }),
  });
}
