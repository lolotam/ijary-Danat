import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * SQL integration suite — real Postgres, real migrations.
 *
 * Kept out of the default `bun run test` project so the fast mock suite stays
 * fast and stays runnable without Docker. Run with `bun run test:sql`.
 *
 * Single-threaded: the suite shares one database, and while each test rolls its
 * own transaction back, concurrent transactions would still contend on the
 * sequences and advisory locks the money-path functions take.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/db/**/*.sqltest.ts"],
    globalSetup: ["src/db/globalSetup.ts"],
    pool: "forks",
    forks: { singleFork: true },
    // `singleFork` alone does NOT deliver the single-threading the comment above
    // describes — it confines the suite to one worker process, but Vitest still
    // interleaves test *files* inside it, so their transactions overlap on the
    // one shared database. Found when migration 76's idempotence test (which
    // replays the migration, taking AccessExclusiveLock on `units` for its DDL)
    // deadlocked against another file's ordinary `insert into public.units`.
    // Every file passed in isolation; only the combination failed.
    fileParallelism: false,
    // Provisioning can rebuild the container from scratch (~100s) on a cold or
    // changed checkout; the default 5s hook timeout would kill it.
    hookTimeout: 300_000,
    testTimeout: 30_000,
  },
});
