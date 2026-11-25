import { describe, expect, test } from "vitest";

import { WHATSAPP_PROVIDERS } from "@/lib/whatsappAvailability";

/**
 * The list is shared with `dispatchNotification`'s own selector so the two
 * cannot drift; its ORDER is the preference the dispatcher applies, since only
 * one provider may be enabled at a time and the first match is the one that
 * sends.
 *
 * There is deliberately no "can this be delivered?" helper here any more. Three
 * review rounds on PR #214 each found another way a predicted outcome diverged
 * from the sender's — the template channel, the admin-only provider table,
 * placeholder identifiers, and finally parameter keys that cannot be checked
 * without the payload the send itself builds. The only reliable oracle for the
 * sender is the sender, so the dialog stopped guessing and the send now reports
 * which channels it actually queued.
 */
describe("WHATSAPP_PROVIDERS", () => {
  test("lists evolution_api first, which is the preferred path", () => {
    expect(WHATSAPP_PROVIDERS[0]).toBe("evolution_api");
  });

  test("covers every provider the dispatcher can select", () => {
    expect([...WHATSAPP_PROVIDERS]).toEqual([
      "evolution_api",
      "postora",
      "whatsapp_cloud_api",
      "twilio",
    ]);
  });
});
