/**
 * ينشئ أول مشرف عام للمنصة من سطر الأوامر، ثم يطلب منه إعداد عامل تحقق ثانٍ عند أول دخول.
 *
 * Run with `bun scripts/create-platform-admin.ts --email admin@example.com --full-name "..."`,
 * with the password in `PLATFORM_ADMIN_PASSWORD` so it never enters the shell
 * history. The service_role work stays behind `bootstrapFirstPlatformAdmin()`
 * in `src/platform/`, the only tree allowed to hold that key.
 *
 * This is a one-time bootstrap, not an admin-management command: once a row
 * exists in `platform_admins`, the helper refuses and the panel adds the next
 * admin through an audited write.
 */
import { bootstrapFirstPlatformAdmin } from "@/platform/platformAdminBootstrap.server";

/** يقرأ قيمة علم من وسائط سطر الأوامر، ويرفض المعلمة الناقصة. */
function readFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`Missing ${name}; usage: --email ... --full-name ...`);
  }
  return argv[index + 1];
}

/** ينفّذ البذر ويطبع معرّف الحساب فقط، دون كلمة المرور. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const email = readFlag(argv, "--email");
  const fullName = readFlag(argv, "--full-name");
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("Set PLATFORM_ADMIN_PASSWORD in the environment before running this script.");
  }

  const admin = await bootstrapFirstPlatformAdmin({ email, fullName, password });
  console.log(`Created platform admin ${admin.email} (${admin.userId}).`);
  console.log("Sign in at /platform/login to enrol the required second factor.");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
