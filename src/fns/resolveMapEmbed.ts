import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Turns whatever the admin pasted into Settings → Company → Map URL into an
 * embeddable Google Maps `src`.
 *
 * Share links from the Maps app are short links (`maps.app.goo.gl/...`) that
 * only reveal their coordinates after following a redirect. The browser cannot
 * do that (no CORS), and the previous client-only helper fell back to
 * `?q=<the whole URL>&output=embed`, which Google cannot geocode — so the
 * iframe rendered blank. Resolving server-side is what makes the setting work.
 */

const inputSchema = z.object({ url: z.string().trim().min(1).max(2048) });

/** Only Google Maps hosts are fetched, so a pasted URL cannot become an SSRF probe. */
const ALLOWED_HOSTS = [
  "goo.gl",
  "maps.app.goo.gl",
  "maps.google.com",
  "www.google.com",
  "google.com",
];

/**
 * Google ccTLDs, anchored at both ends: `google.com`, `google.com.kw`,
 * `www.google.co.uk`, `maps.google.de`. Anchoring matters — a trailing-suffix
 * check like /google\.[a-z.]+$/ also accepts `google.com.evil.example`, which
 * an attacker can register and point at an internal address.
 */
const GOOGLE_DOMAIN = /^(?:[a-z0-9-]+\.)*google\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;

export function isAllowedHost(rawUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    // https only — a plaintext hop would also permit http://<internal-ip>/.
    if (protocol !== "https:") return false;
    return ALLOWED_HOSTS.includes(hostname.toLowerCase()) || GOOGLE_DOMAIN.test(hostname);
  } catch {
    return false;
  }
}

function isEmbedUrl(url: string): boolean {
  return url.includes("/maps/embed") || url.includes("output=embed");
}

/** Coordinates are the most reliable embed key — pull them out however they appear. */
export function coordinatesFrom(url: string): string | null {
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return `${at[1]},${at[2]}`;
  const bang = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (bang) return `${bang[1]},${bang[2]}`;
  const query = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (query) return `${query[1]},${query[2]}`;
  return null;
}

function placeNameFrom(url: string): string | null {
  const place = url.match(/\/maps\/place\/([^/@?]+)/);
  if (!place) return null;
  try {
    return decodeURIComponent(place[1]).replace(/\+/g, " ");
  } catch {
    return null;
  }
}

/** Builds the embed src for an already-resolved (long) maps URL. */
export function embedSrcForResolvedUrl(url: string): string | null {
  if (isEmbedUrl(url)) return url;
  const coordinates = coordinatesFrom(url);
  if (coordinates) {
    return `https://www.google.com/maps?q=${encodeURIComponent(coordinates)}&output=embed`;
  }
  const place = placeNameFrom(url);
  if (place) return `https://www.google.com/maps?q=${encodeURIComponent(place)}&output=embed`;
  // Nothing embeddable could be derived; the caller falls back to a link-out
  // rather than rendering an iframe that would come up blank.
  return null;
}

const MAX_REDIRECTS = 5;

/**
 * Follows redirects manually, re-checking the host allowlist at every hop.
 *
 * `redirect: "follow"` would validate only the URL we were given: a short link
 * is attacker-controlled content, so `goo.gl/x` could redirect to
 * `http://169.254.169.254/` or a localhost service and we would fetch it and
 * read the body — an SSRF. Stopping at the first non-Google hop closes that.
 */
async function followWithinAllowedHosts(
  startUrl: string,
): Promise<{ finalUrl: string; response: Response } | null> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedHost(current)) return null;
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        // Google serves the coordinate-bearing desktop URL to a browser UA.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return { finalUrl: current, response };
    }
    // Relative Location headers resolve against the current URL.
    current = new URL(location, current).toString();
  }
  return null;
}

export interface ResolvedMapEmbed {
  embedSrc: string | null;
  resolvedUrl: string | null;
}

export const resolveMapEmbed = createServerFn({ method: "GET" })
  .validator(inputSchema)
  .handler(async ({ data }): Promise<ResolvedMapEmbed> => {
    const url = data.url;
    if (isEmbedUrl(url)) return { embedSrc: url, resolvedUrl: url };
    if (!isAllowedHost(url)) return { embedSrc: null, resolvedUrl: null };

    // A direct long-form URL often already carries coordinates.
    const direct = embedSrcForResolvedUrl(url);
    if (direct) return { embedSrc: direct, resolvedUrl: url };

    try {
      const resolved = await followWithinAllowedHosts(url);
      if (!resolved) return { embedSrc: null, resolvedUrl: null };

      const fromFinalUrl = embedSrcForResolvedUrl(resolved.finalUrl);
      if (fromFinalUrl) return { embedSrc: fromFinalUrl, resolvedUrl: resolved.finalUrl };

      // Short links sometimes land on a consent/interstitial page whose body
      // still carries the coordinates.
      const coordinates = coordinatesFrom(await resolved.response.text());
      if (coordinates) {
        return {
          embedSrc: `https://www.google.com/maps?q=${encodeURIComponent(coordinates)}&output=embed`,
          resolvedUrl: resolved.finalUrl,
        };
      }
      return { embedSrc: null, resolvedUrl: resolved.finalUrl };
    } catch {
      return { embedSrc: null, resolvedUrl: null };
    }
  });
