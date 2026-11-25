import { execFileSync } from "node:child_process";

/**
 * Vitest globalSetup for the SQL integration suite.
 *
 * Ensures a Postgres container exists with every migration in db/migrations
 * applied, by delegating to scripts/test-db.sh. The script rebuilds only when
 * the migration sources change, so a warm run costs a couple of seconds.
 *
 * The connection URL is deterministic (see testDbUrl()), so nothing needs to be
 * passed back to the workers.
 */
export async function setup(): Promise<void> {
  try {
    execFileSync("bash", ["scripts/test-db.sh"], {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    });
  } catch {
    // The script already printed the failing migration and its Postgres error
    // to stderr; adding the stack trace on top only buries it.
    throw new Error(
      "Could not provision the SQL test database. Is Docker running? " +
        "See the output above for the failing migration.",
    );
  }
}
