import { getRouteApi } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

type BrandLogoProps = {
  name: string;
  subName?: string;
  onDark?: boolean;
  className?: string;
};

const rootRoute = getRouteApi("__root__");

/** Company logo uploaded in Settings > Company (falls back to the bundled asset). */
export function useBrandLogoUrl(): string {
  try {
    const data = rootRoute.useLoaderData() as { branding?: { logoUrl: string | null } } | undefined;
    return data?.branding?.logoUrl || "/brand/logo.png";
  } catch {
    return "/brand/logo.png";
  }
}

export function BrandLogo({ name, subName, onDark = false, className }: BrandLogoProps) {
  const logoUrl = useBrandLogoUrl();
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <img
        src={logoUrl}
        alt={name}
        className="size-14 shrink-0 rounded-xl object-contain sm:size-16"
      />
      <div className="min-w-0 leading-tight">
        <p className={cn("truncate text-base font-semibold", onDark && "text-ink-foreground")}>
          {name}
        </p>
        {subName && (
          <p
            className={cn("truncate text-sm", onDark ? "text-ink-muted" : "text-muted-foreground")}
          >
            {subName}
          </p>
        )}
      </div>
    </div>
  );
}
