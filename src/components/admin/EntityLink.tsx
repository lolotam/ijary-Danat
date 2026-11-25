import { Link } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

const ENTITY_ROUTES = {
  tenant: "/admin/tenants/$id",
  unit: "/admin/units/$id",
  property: "/admin/properties/$id",
} as const;

export type EntityKind = keyof typeof ENTITY_ROUTES;

/**
 * روابط تنقّل داخل الجداول والبطاقات إلى صفحة مستأجر أو وحدة أو عقار.
 *
 * Renders plain text when `id` is missing so list columns can always call this
 * without a null check at every site.
 *
 * Rows that navigate on click/Enter use `stopRowEvents` so the link does not
 * double-navigate: the click (and the Enter/Space keydown that activates it)
 * is stopped from reaching the row's own handlers before the caller's `onClick`
 * still runs.
 */
export function EntityLink({
  kind,
  id,
  children,
  className,
  onClick,
  onKeyDown,
  stopRowEvents,
}: {
  kind: EntityKind;
  id: string | null | undefined;
  children: ReactNode;
  className?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
  stopRowEvents?: boolean;
}) {
  if (!id) return <>{children ?? "—"}</>;

  // يوقف انتشار الحدث إلى الصف القابل للنقر قبل تمريره لمتصل المكوّن.
  const handleClick = stopRowEvents
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
        onClick?.(event);
      }
    : onClick;
  const handleKeyDown = stopRowEvents
    ? (event: KeyboardEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
        onKeyDown?.(event);
      }
    : onKeyDown;

  return (
    <Link
      to={ENTITY_ROUTES[kind]}
      params={{ id }}
      className={cn("text-primary underline underline-offset-2 hover:text-primary/80", className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </Link>
  );
}
