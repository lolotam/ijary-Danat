import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { globSync } from "tinyglobby";

import { DialogFooter, DialogHeader } from "./dialog";

describe("Dialog layout", () => {
  test("uses logical alignment and spacing in both reading directions", () => {
    const headerMarkup = renderToStaticMarkup(<DialogHeader>Heading</DialogHeader>);
    const footerMarkup = renderToStaticMarkup(<DialogFooter>Actions</DialogFooter>);

    expect(headerMarkup).toContain("sm:text-start");
    expect(footerMarkup).toContain("sm:gap-x-2");
    expect(footerMarkup).not.toContain("space-x-2");
  });
});

/**
 * Gmail compose, 2026-08-01 — the dialog opened anchored to the bottom-right of
 * the page instead of centred.
 *
 * `DialogContent` centres itself with `left-[50%] top-[50%]` plus
 * `translate-x-[-50%] translate-y-[-50%]`. That pulls the box back by half its
 * own size, and it works for every dialog here that sizes with `max-h-*` and
 * inherits `w-full`. It does not survive a dialog given a *definite* height and
 * width: the compose window at `h-[92vh] w-[96vw]` ended up positioned by its
 * top-left corner at the page centre, so most of it hung off the screen.
 *
 * The fix is to stop depending on the transform — `inset-0` plus `m-auto` with
 * a definite width and height centres on both axes and cannot be defeated by
 * one. This is what the app's other full-size dialog already does.
 *
 * Read from source because `DialogContent` renders through a Radix portal,
 * which `renderToStaticMarkup` does not produce, and because the rule spans
 * every route and component rather than one render.
 */
const DEFINITE_HEIGHT = /\b(?<!max-)h-(\[[^\]]+\]|dvh|screen|full)/;

function dialogContentClasses(source: string): string[] {
  return [...source.matchAll(/<DialogContent[^>]*?className=\{?"([^"]*)"/gs)].map(
    (match) => match[1],
  );
}

describe("a dialog with a definite size centres without the transform", () => {
  const files = globSync(["src/**/*.tsx"], { cwd: process.cwd() }).filter(
    (file) => !file.endsWith("dialog.tsx"),
  );

  test("every fixed-height DialogContent neutralises the base translate", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const classes of dialogContentClasses(source)) {
        if (!DEFINITE_HEIGHT.test(classes)) continue;
        const centred =
          classes.includes("translate-x-0") &&
          classes.includes("translate-y-0") &&
          classes.includes("inset-0");
        if (!centred) offenders.push(`${file}: ${classes}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Admin invoices, 2026-08-07 — "Mark as paid" did nothing at all. No dialog, no
 * request, no error.
 *
 * `MarkInvoicePaidDialog` had been placed inside the *print* dialog's
 * `DialogContent`. `DialogContent` renders through `DialogPortal`, and Radix
 * unmounts a portal's children whenever its root is closed — there is no
 * `forceMount` here. The print dialog is open only while an invoice is being
 * previewed, so for every other moment the component holding the reason picker
 * was not in the tree. Clicking the button still set the state; nothing was
 * mounted to read it.
 *
 * This is a placement defect, not a rendering one, so no amount of testing
 * `MarkInvoicePaidDialog` itself could have caught it — in isolation it renders
 * perfectly. The property that was violated belongs to the composition, and it
 * is checked from source for the same two reasons as the rule above: portals
 * emit nothing under `renderToStaticMarkup`, and the rule has to hold across
 * every route rather than in one render.
 *
 * A dialog nested inside another dialog's content is not always wrong — a
 * confirmation raised *from* an open dialog belongs there. It is wrong whenever
 * the inner dialog is opened by something outside the outer one, which is the
 * only shape that occurs here. Should a genuine nested confirmation ever be
 * added, narrow this rule rather than deleting it.
 *
 * NARROWED, 2026-08-30 — `ExtraChargeWaiverDialog`. It is the shape the
 * paragraph above reserves: opened only from `ConcessionsDialog`'s own submit
 * handler, so it cannot be reached while the outer dialog is closed, and being
 * unmounted along with the outer dialog is the behaviour that is wanted — a
 * half-answered waiver must not outlive the form that raised it.
 *
 * The allowlist is by component name AND by the file allowed to nest it, so
 * adding the same component somewhere else still fails. Adding an entry is a
 * decision about one composition; it is not a way to quiet the rule.
 */
const NESTED_CONFIRMATIONS_ALLOWED: ReadonlyArray<{ component: string; file: string }> = [
  {
    component: "ExtraChargeWaiverDialog",
    file: "src/components/admin/contracts/ConcessionsDialog.tsx",
  },
];
const DIALOG_PRIMITIVES = new Set([
  "DialogClose",
  "DialogContent",
  "DialogDescription",
  "DialogFooter",
  "DialogHeader",
  "DialogOverlay",
  "DialogPortal",
  "DialogTitle",
  "DialogTrigger",
]);

function dialogsNestedInContent(source: string): string[] {
  const nested: string[] = [];
  let depth = 0;
  for (const match of source.matchAll(/<(\/?)(\w+)\b/g)) {
    const [, slash, name] = match;
    const isClosing = slash === "/";
    if (name === "DialogContent") {
      depth += isClosing ? -1 : 1;
      continue;
    }
    if (depth > 0 && !isClosing && name.endsWith("Dialog") && !DIALOG_PRIMITIVES.has(name)) {
      nested.push(`${name} at line ${source.slice(0, match.index).split("\n").length}`);
    }
  }
  return nested;
}

describe("a dialog opened from outside another dialog is mounted beside it", () => {
  const files = globSync(["src/**/*.tsx"], { cwd: process.cwd() }).filter(
    (file) => !file.endsWith("dialog.test.tsx"),
  );

  test("no dialog component is nested inside another dialog's content", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const nested of dialogsNestedInContent(source)) {
        const component = nested.split(" ")[0];
        const allowed = NESTED_CONFIRMATIONS_ALLOWED.some(
          (entry) => entry.component === component && file.split("\\").join("/") === entry.file,
        );
        if (!allowed) offenders.push(`${file}: ${nested}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
