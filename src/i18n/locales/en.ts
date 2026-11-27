import { contractBuilder } from "./en/contractBuilder";
import { admin } from "./en/admin";
import { users } from "./en/users";
import { documents } from "./en/documents";
import { invoices } from "./en/invoices";
import { notificationChannel } from "./en/notificationChannel";
import { landingSettings } from "./en/landingSettings";
import { audit } from "./en/audit";
import { jobs } from "./en/jobs";
import { publicPages } from "./en/publicPages";
import { passwordReset } from "./en/passwordReset";
import { modules } from "./en/modules";
import { platform } from "./en/platform";
import { platformCompanies } from "./en/platformCompanies";
import { subscriptions } from "./en/subscriptions";

/**
 * كتالوج الترجمة الإنجليزية — يجب أن يطابق مفاتيح `ar.ts` حرفياً.
 *
 * `dictionary.test.ts` fails the build on a key present in only one locale, so
 * add every key to both files in the same commit.
 *
 * Each module holds whole key namespaces and stays under the 500–600 line
 * ceiling; both locales use the same module names so a key's ar and en
 * entries are always found in files of the same name.
 */
export const en: Record<string, string> = {
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
  ...platform,
  ...platformCompanies,
  ...subscriptions,
};
