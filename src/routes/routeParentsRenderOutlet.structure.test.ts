import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * يتحقق أن كل مسار متفرّع عن مسار أب، يكون الأب فيه راسماً `<Outlet />`.
 *
 * Regression test for the close-out wizard being unreachable (found 2026-09-03).
 * TanStack Router matches a nested route happily even when the parent component
 * has no `<Outlet />` — the parent renders, the child silently does not, and the
 * URL shows the parent's page. That is how `/admin/contracts/$id/closeout` served
 * the contracts *list* for the whole life of the close-out feature: the wizard
 * was nested under `/admin/contracts`, which renders a table and no outlet.
 *
 * Nothing in typecheck, lint or the unit suite can see that — it is a property of
 * the generated tree plus the parent's JSX, so it is asserted here. The fix for a
 * failure is normally the trailing-underscore opt-out (`admin.contracts_.…`),
 * which keeps the URL and re-parents the route onto a real layout.
 */
const ROUTE_TREE = resolve(__dirname, "../routeTree.gen.ts");

/** الجذور التي ليس لها ملف مكوّن نقرؤه — تُستثنى من الفحص. */
const SYNTHETIC_PARENTS = new Set(["rootRouteImport", "rootServerRouteImport"]);

/**
 * يستخرج من شجرة المسارات المولَّدة أزواج (الابن، الأب) مع ملف كل منهما.
 *
 * Reads the generated tree rather than the route files themselves because the
 * parent relationship is decided by the file-name convention, not by anything
 * written inside a route module.
 */
function readParentLinks(): Array<{ child: string; parent: string; parentFile: string | null }> {
  const source = readFileSync(ROUTE_TREE, "utf8");

  const fileByRouteVar = new Map<string, string>();
  for (const match of source.matchAll(
    /import \{ Route as (\w+)RouteImport \} from '\.\/routes\/([^']+)'/g,
  )) {
    fileByRouteVar.set(`${match[1]}Route`, match[2]);
  }

  const links: Array<{ child: string; parent: string; parentFile: string | null }> = [];
  for (const match of source.matchAll(
    /const (\w+Route) =\s*\w+RouteImport\.update\(\{[\s\S]*?getParentRoute: \(\) => (\w+),/g,
  )) {
    const [, child, parent] = match;
    if (SYNTHETIC_PARENTS.has(parent)) continue;
    links.push({ child, parent, parentFile: fileByRouteVar.get(parent) ?? null });
  }
  return links;
}

/**
 * يقرأ ملف المسار من مساره كما تكتبه الشجرة المولَّدة، بلا امتداد.
 *
 * `src/routes/` holds both `.tsx` page routes and `.ts` API routes, and the
 * generated import path carries no extension.
 */
function readRouteSource(routePath: string): string {
  const sourceFile = [".tsx", ".ts"]
    .map((extension) => resolve(__dirname, `${routePath}${extension}`))
    .find((candidate) => existsSync(candidate));
  if (!sourceFile) throw new Error(`no .tsx or .ts source file for route ${routePath}`);
  return readFileSync(sourceFile, "utf8");
}

describe("every parent route renders an Outlet", () => {
  const links = readParentLinks();

  test("the generated tree actually yields parent links to check", () => {
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((link) => link.child === "AdminContractsIdCloseoutRoute")).toBe(true);
  });

  test.each(links.map((link) => [link.child, link.parent, link.parentFile] as const))(
    "%s nests under %s, which must render <Outlet />",
    (child, parent, parentFile) => {
      expect(parentFile, `no source file resolved for parent ${parent} of ${child}`).not.toBeNull();
      const parentSource = readRouteSource(parentFile as string);
      expect(
        parentSource,
        `${parent} is the parent of ${child} but renders no <Outlet />, so ${child} never mounts`,
      ).toContain("<Outlet");
    },
  );
});
