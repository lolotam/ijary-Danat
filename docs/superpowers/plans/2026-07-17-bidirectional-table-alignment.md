# Bidirectional Table Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all frontend table columns and content follow Arabic RTL or English LTR direction, while keeping telephone entry LTR in both locales.

**Architecture:** Direction is owned by the shared table primitive rather than individual routes. The `Table` reads the active locale direction from `useOptionalI18n` and still renders without an i18n provider, while shared header and cell classes use logical start alignment. The base `Input` component applies LTR only for telephone inputs when no explicit direction was supplied.

**Tech Stack:** React 19, TypeScript, Vitest, Tailwind CSS 4, shadcn/ui, TanStack Start.

---

## File Map

| Path                                    | Responsibility                                                             |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `src/components/ui/table.tsx`           | Provides locale-aware table direction and logical table-content alignment. |
| `src/components/ui/input.tsx`           | Defaults telephone inputs to LTR without overriding explicit directions.   |
| `src/routes/admin.properties.index.tsx` | Removes the temporary route-level table direction workaround.              |
| `src/components/ui/table.test.tsx`      | Verifies rendered table direction and logical cell alignment.              |
| `src/components/ui/input.test.tsx`      | Verifies automatic telephone-input direction and explicit overrides.       |

### Task 1: Establish Rendered Direction Regression Tests

**Files:**

- Create: `src/components/ui/table.test.tsx`
- Create: `src/components/ui/input.test.tsx`

- [ ] **Step 1: Add a test harness for the active locale direction**

Create `src/components/ui/table.test.tsx` with the real `I18nProvider` and table primitive. It must also confirm that the table can render without the provider.

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { I18nProvider } from "@/i18n/provider";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

function renderTable(direction?: "ltr" | "rtl") {
  return renderToStaticMarkup(
    <I18nProvider>
      <Table dir={direction}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Value</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </I18nProvider>,
  );
}

describe("Table", () => {
  test("renders the active Arabic direction and logical alignment", () => {
    const markup = renderTable();

    expect(markup).toContain('dir="rtl"');
    expect(markup).toContain("text-start");
  });

  test("preserves an explicit table direction", () => {
    expect(renderTable("ltr")).toContain('dir="ltr"');
  });
});
```

- [ ] **Step 2: Add a telephone input direction test**

Create `src/components/ui/input.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { Input } from "@/components/ui/input";

describe("Input", () => {
  test("keeps telephone entry left-to-right", () => {
    expect(renderToStaticMarkup(<Input type="tel" />)).toContain('dir="ltr"');
  });

  test("preserves a caller-provided direction", () => {
    expect(renderToStaticMarkup(<Input type="tel" dir="rtl" />)).toContain('dir="rtl"');
  });
});
```

- [ ] **Step 3: Verify the red state**

Run:

```bash
npm test -- src/components/ui/table.test.tsx src/components/ui/input.test.tsx
```

Expected: the Arabic table test fails because the shared `Table` does not render `dir`, the table-cell markup lacks `text-start`, and the telephone input test fails because `Input` does not add `dir="ltr"`.

### Task 2: Centralize Table Direction And Alignment

**Files:**

- Modify: `src/components/ui/table.tsx`

- [ ] **Step 1: Read the active direction in the shared table primitive**

Add the optional i18n import:

```tsx
import { useOptionalI18n } from "@/i18n/provider";
```

Replace the existing `Table` definition with the following implementation. It applies the locale direction by default and preserves an explicit `dir` from a specialized caller.

```tsx
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, dir, ...props }, ref) => {
    const locale = useOptionalI18n();

    return (
      <div className="relative w-full overflow-auto">
        <table
          ref={ref}
          dir={dir ?? locale?.dir}
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
    );
  },
);
```

- [ ] **Step 2: Apply logical cell alignment**

Change the `TableCell` class list so it begins with `p-2 text-start align-middle`. The full class string must be:

```tsx
"p-2 text-start align-middle [&:has([role=checkbox])]:ps-4 [&:has([role=checkbox])]:pe-2 [&>[role=checkbox]]:translate-y-[2px]";
```

Keep the existing `TableHead` `text-start` class unchanged. Do not add `text-right`, `text-left`, CSS selectors, or route-specific classes because those would not adapt to locale direction.

- [ ] **Step 3: Verify the shared table test is green**

Run:

```bash
npm test -- src/components/ui/table.test.tsx
```

Expected: PASS. The rendered Arabic table contains `dir="rtl"` and both header and cell classes contain `text-start`; an explicit `dir="ltr"` remains authoritative; the table also renders without an i18n provider.

### Task 3: Preserve LTR Telephone Entry

**Files:**

- Modify: `src/components/ui/input.tsx`

- [ ] **Step 1: Default telephone inputs to LTR without overriding callers**

Destructure `dir` from the input props and set the rendered input direction as follows:

```tsx
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, dir, type, ...props }, ref) => {
    return (
      <input
        type={type}
        dir={dir ?? (type === "tel" ? "ltr" : undefined)}
        className={cn(
          "flex h-9 w-full rounded-[12px] border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
```

Do not change non-telephone input direction. Existing callers with an explicit `dir="ltr"` or `dir="rtl"` continue to win.

- [ ] **Step 2: Verify the telephone test is green**

Run:

```bash
npm test -- src/components/ui/input.test.tsx
```

Expected: PASS. A telephone input renders LTR and an explicitly RTL telephone input remains RTL.

### Task 4: Remove The Temporary Properties Override And Validate Affected Routes

**Files:**

- Modify: `src/routes/admin.properties.index.tsx`
- Inspect: `src/routes/admin.settings.notifications.tsx`
- Inspect: `src/routes/admin.settings.users.tsx`

- [ ] **Step 1: Remove the temporary route-level direction binding**

In `PropertiesPage`, restore the existing locale hook usage:

```tsx
const { t } = useI18n();
```

Restore the properties table tag to:

```tsx
<Table>
```

The shared component now applies direction for this table, the notification pool and template tables, and the user role tables without any route-specific `dir` prop.

- [ ] **Step 2: Search for unintended physical alignment overrides**

Run:

```bash
rg -n 'text-(left|right)' src --glob '*.{ts,tsx}'
```

Expected: inspect each result. Keep only intentional numeric, technical, or icon layouts. Replace any ordinary `TableHead` or `TableCell` physical alignment with logical `text-start` or `text-end` as appropriate.

- [ ] **Step 3: Run the focused UI regression suite**

Run:

```bash
npm test -- src/components/ui/table.test.tsx src/components/ui/input.test.tsx
```

Expected: PASS.

### Task 5: Quality Gates, Commit, And Push

**Files:**

- Modify: `graphify-out/` only through `graphify update .`

- [ ] **Step 1: Run project verification**

Run:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: each command exits with status 0. If a pre-existing failure occurs, record its complete output and do not hide, skip, or weaken the failing check.

- [ ] **Step 2: Review the exact commit contents**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: only the shared alignment source files, their focused tests, the already approved specification and plan, and intentional Graphify outputs are staged. Do not stage unrelated files.

- [ ] **Step 3: Commit the alignment fix**

Run:

```bash
git add src/components/ui/table.tsx src/components/ui/input.tsx src/routes/admin.properties.index.tsx src/components/ui/table.test.tsx src/components/ui/input.test.tsx docs/superpowers/specs/2026-07-17-bidirectional-table-alignment-design.md docs/superpowers/plans/2026-07-17-bidirectional-table-alignment.md graphify-out
```

- [ ] **Step 4: Push the current branch**

Run:

```bash
git push
```

Expected: the remote tracking branch accepts the commit without force-pushing or history rewrites.

## Self-Review

- Spec coverage: Tasks 2 and 4 make all shared tables, including Properties, Notifications, and Users, follow locale direction; Task 3 preserves the phone exception; Task 5 covers verification and deployment.
- Placeholder scan: no incomplete steps or unspecified files remain.
- Type consistency: `dir` is the native HTML input/table direction prop; `useI18n` already exposes `dir` as `"rtl" | "ltr"`.
