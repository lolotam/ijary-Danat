# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
defines a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` — those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic — bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell — wraps every page; preserve `<Outlet />`     |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## Search params

List-scope filters that should survive refresh, shareable links, and
post-action redirects (e.g. after close-out) use **URL search params**,
declared on the route with `validateSearch` + Zod.

| Param    | Meaning                              | Convention                                                                      |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `?view=` | List scope: current / archived / all | Lowercase enum values, always defaulted via `.catch("current")`, never required |

Leave `search` / `page` / local filters (`stateFilter`, etc.) as component
`useState` unless migrating them deliberately — do not mix both in one change.

Read with `Route.useSearch()`, change with `navigate({ search })`. This is the
first search-param convention for list scope in this repo.
