import type { Json, NotificationProvider } from "@/integrations/supabase/database.types";
import { PROVIDER_CONFIG_SHAPE } from "@/lib/providers/configValidation";

/**
 * ترتيب حقول المزوّد: الإلزامية أولًا ثم الاختيارية.
 *
 * Read off `PROVIDER_CONFIG_SHAPE`, the same map the validator uses, so a key
 * added there appears here without anyone remembering to update a second list —
 * the previous JSON box could drift from the validator silently.
 */
export function providerFieldKeys(provider: NotificationProvider): {
  key: string;
  placeholder: string;
  required: boolean;
}[] {
  const shape = PROVIDER_CONFIG_SHAPE[provider];
  return [
    ...Object.entries(shape.required).map(([key, placeholder]) => ({
      key,
      placeholder,
      required: true,
    })),
    ...Object.entries(shape.optional).map(([key, placeholder]) => ({
      key,
      placeholder,
      required: false,
    })),
  ];
}

/**
 * يحوّل قيم الحقول إلى كائن الإعدادات، ويحذف الفارغ منها.
 *
 * An empty box means "not set" and is dropped rather than written as `""`. The
 * database constraint rejects a blank where it expects an environment-variable
 * name, so sending one would surface as a constraint violation on save instead
 * of the field simply being absent.
 */
export function draftToConfig(draft: Record<string, string>): Record<string, string> {
  // `fromEntries` for the same reason as `storedConfig`: a `__proto__` key
  // assigned onto a plain object never becomes an own property.
  return Object.fromEntries(
    Object.entries(draft)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value !== ""),
  );
}

/**
 * إعدادات المزوّد المخزَّنة ككائن، أو كائن فارغ إن لم تكن كذلك.
 *
 * The form renders only the keys `PROVIDER_CONFIG_SHAPE` knows about, but the
 * column accepts others — migration 07 seeds `template_namespace_ref`. Saving
 * has to merge over this rather than replace it, or a key this screen cannot
 * display is a key it silently deletes.
 */
export function storedConfig(config: Json | null): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
  // Values are carried through as they are, not stringified. The column is
  // unrestricted `jsonb`, so a nested object would come back "[object Object]"
  // and an array as a comma-joined string — corrupting on save the very keys
  // this merge exists to preserve.
  //
  // Built with `fromEntries` rather than assigned key by key: `stored["__proto__"]`
  // on a plain object sets the prototype instead of creating an own property, so
  // a config with that key would silently lose it on the next save.
  return Object.fromEntries(
    Object.entries(config as Record<string, unknown>).filter(([, value]) => value != null),
  );
}

/** يقرأ قيمة مفتاح من إعدادات المزوّد المخزَّنة كنص. */
export function configValue(config: Json | null, key: string): string {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
