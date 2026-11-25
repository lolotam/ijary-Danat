import { contractBuilder } from "./en/contractBuilder";
import { admin } from "./en/admin";
import { users } from "./en/users";
import { documents } from "./en/documents";
import { invoices } from "./en/invoices";
import { notificationChannel } from "./en/notificationChannel";
import { landingSettings } from "./en/landingSettings";
import { audit } from "./en/audit";

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
};
