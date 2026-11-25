import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    // Agent tools check a second copy of this repo out inside it — `.auto-claude`
    // and `.kilo/worktrees/*` are both real git worktrees, so `git status` stays
    // quiet about them and nothing else gives the duplication away.
    //
    // Two ways that bites. A stale copy carries old tests that read repo-root
    // files through `process.cwd()` and fail against newer code. And a current
    // copy is worse than a stale one: every test simply runs twice, the suite
    // takes twice as long, and the totals look plausible — 688 files where the
    // tree holds 344 — so a failure could be masked or invented by code that is
    // not the code under review.
    exclude: [
      ...configDefaults.exclude,
      ".auto-claude/**",
      ".kilo/**",
      ".claude/**",
      ".worktrees/**",
    ],
  },
});
