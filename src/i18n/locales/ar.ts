import { contractBuilder } from "./ar/contractBuilder";
import { admin } from "./ar/admin";
import { users } from "./ar/users";
import { documents } from "./ar/documents";
import { invoices } from "./ar/invoices";
import { notificationChannel } from "./ar/notificationChannel";
import { landingSettings } from "./ar/landingSettings";
import { audit } from "./ar/audit";
import { jobs } from "./ar/jobs";
import { publicPages } from "./ar/publicPages";
import { passwordReset } from "./ar/passwordReset";
import { modules } from "./ar/modules";

/**
 * كتالوج الترجمة العربية — اللغة الافتراضية للمنتج.
 *
 * Split from `dictionary.ts` by locale (audit L4): the combined catalog passed
 * 4,500 lines and was about to grow by several hundred more as the inline
 * `locale === "ar" ? … : …` strings moved in. Splitting by locale rather than by
 * feature keeps `dictionary.test.ts` working unchanged — it compares the two
 * objects, and each object still lives whole in one file.
 *
 * Each module holds whole key namespaces and stays under the 500–600 line
 * ceiling; both locales use the same module names so a key's ar and en
 * entries are always found in files of the same name.
 */
export const ar: Record<string, string> = {
  ...contractBuilder,
  ...admin,
  ...users,
  ...documents,
  ...invoices,
  ...notificationChannel,
  ...landingSettings,
  ...audit,
  ...jobs,
  ...publicPages,
  ...passwordReset,
  ...modules,
};
