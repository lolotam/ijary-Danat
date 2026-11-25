import { getRouteApi } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

/** IJARY house mark, used when the company has not uploaded its own logo. */
export const IJARY_MARK = {
  light: "/brand/ijary-mark.svg",
  onDark: "/brand/ijary-mark-on-dark.svg",
} as const;

type BrandMarkProps = {
  alt: string;
  /** The mark sits on a dark panel (sidebar, sign-in hero) in both themes. */
  onDark?: boolean;
  className?: string;
};

type BrandLogoProps = {
  name: string;
  subName?: string;
  onDark?: boolean;
  className?: string;
};

const rootRoute = getRouteApi("__root__");

/**
 * يرجع رابط شعار الشركة المرفوع من الإعدادات، أو null لو مفيش شعار.
 *
 * Returns null rather than a bundled default so the caller can pick the IJARY
 * mark that suits its background: an uploaded logo is shown as-is, but the
 * bundled mark ships in a light and an on-dark colourway.
 */
export function useCompanyLogoUrl(): string | null {
  try {
    const data = rootRoute.useLoaderData() as { branding?: { logoUrl: string | null } } | undefined;
    return data?.branding?.logoUrl || null;
  } catch {
    return null;
  }
}

/**
 * يعرض شعار الشركة، أو علامة IJARY باللون المناسب للخلفية لو الشركة ما رفعتش شعار.
 *
 * The mark's colours are baked into the SVG, so on a theme-following surface
 * both colourways are rendered and CSS hides the wrong one; swapping the src
 * in JS would flash the wrong mark before hydration.
 */
export function BrandMark({ alt, onDark = false, className }: BrandMarkProps) {
  const companyLogoUrl = useCompanyLogoUrl();
  const imgClass = cn("shrink-0 object-contain", className);

  if (companyLogoUrl) return <img src={companyLogoUrl} alt={alt} className={imgClass} />;
  if (onDark) return <img src={IJARY_MARK.onDark} alt={alt} className={imgClass} />;
  return (
    <>
      <img src={IJARY_MARK.light} alt={alt} className={cn(imgClass, "dark:hidden")} />
      <img
        src={IJARY_MARK.onDark}
        alt=""
        aria-hidden="true"
        className={cn(imgClass, "hidden dark:block")}
      />
    </>
  );
}

/** يعرض شعار الشركة مع اسمها واسم فرعي اختياري تحته. */
export function BrandLogo({ name, subName, onDark = false, className }: BrandLogoProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <BrandMark alt={name} onDark={onDark} className="size-14 rounded-xl sm:size-16" />
      <div className="min-w-0 leading-tight">
        <p className={cn("truncate text-base font-bold", onDark && "text-ink-foreground")}>
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
