import { describe, expect, it, vi } from "vitest";

import { fetchWhatsAppContacts } from "@/hooks/useWhatsAppContactsData";
import { fetchWhatsAppChats, fetchWhatsAppMessagesPage } from "@/hooks/useWhatsAppInbox";
import { fetchActiveWhatsAppConnectionId } from "@/hooks/whatsappSession";

const CONNECTION_A = "22222222-2222-4222-8222-222222222222";
const CONNECTION_B = "33333333-3333-4333-8333-333333333333";

/** يبني عميل Supabase وهمياً في الذاكرة يصفّي الصفوف حسب قيود `eq` و `in` للتحقق من عزل الاتصال. */
function createInMemoryWhatsAppClient(fixtures: {
  connections?: Array<{ id: string; is_active: boolean }>;
  chats?: Array<{
    connection_id: string | null;
    chat_number: string;
    display_name: string | null;
    avatar_url: string | null;
    last_message_at: string | null;
  }>;
  contacts?: Array<{
    id: string;
    connection_id: string | null;
    phone: string;
    name: string | null;
    avatar_url: string | null;
    tenant_id: string | null;
    created_at: string;
  }>;
  messages?: Array<{
    id: string;
    connection_id: string | null;
    message_id: string;
    chat_number: string;
    sent_at: string;
  }>;
  contactContracts?: Array<{
    connection_id: string | null;
    contact_id: string;
    contract_id: string;
  }>;
}) {
  const tableRows: Record<string, Array<Record<string, unknown>>> = {
    whatsapp_connections: (fixtures.connections ?? []) as Array<Record<string, unknown>>,
    whatsapp_chats: (fixtures.chats ?? []) as Array<Record<string, unknown>>,
    whatsapp_contacts: (fixtures.contacts ?? []) as Array<Record<string, unknown>>,
    whatsapp_messages: (fixtures.messages ?? []) as Array<Record<string, unknown>>,
    whatsapp_contact_contracts: (fixtures.contactContracts ?? []) as Array<Record<string, unknown>>,
    contracts: [],
    tenants: [],
  };

  return {
    from: vi.fn((table: string) => {
      let rows = [...(tableRows[table] ?? [])];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return chain;
        },
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return chain;
    }),
  };
}

describe("WhatsApp inbox hooks connection scoping (T163)", () => {
  it("resolves the active connection id from whatsapp_connections", async () => {
    const client = createInMemoryWhatsAppClient({
      connections: [
        { id: CONNECTION_A, is_active: false },
        { id: CONNECTION_B, is_active: true },
      ],
    });

    const id = await fetchActiveWhatsAppConnectionId(client as never);
    expect(id).toBe(CONNECTION_B);
  });

  it("scopes chats and directory name lookups to the active connection_id", async () => {
    const client = createInMemoryWhatsAppClient({
      chats: [
        {
          connection_id: CONNECTION_A,
          chat_number: "96550111222",
          display_name: "Old QR Chat",
          avatar_url: null,
          last_message_at: "2026-11-27T10:00:00Z",
        },
        {
          connection_id: CONNECTION_B,
          chat_number: "96550333444",
          display_name: "Push Name",
          avatar_url: null,
          last_message_at: "2026-11-27T11:00:00Z",
        },
      ],
      contacts: [
        {
          id: "c-1",
          connection_id: CONNECTION_A,
          phone: "96550333444",
          name: "Wrong Connection Contact",
          avatar_url: null,
          tenant_id: null,
          created_at: "2026-11-27T09:00:00Z",
        },
        {
          id: "c-2",
          connection_id: CONNECTION_B,
          phone: "96550333444",
          name: "Cloud Contact Name",
          avatar_url: null,
          tenant_id: null,
          created_at: "2026-11-27T10:00:00Z",
        },
      ],
    });

    const chats = await fetchWhatsAppChats(client as never, CONNECTION_B, "");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      connection_id: CONNECTION_B,
      chat_number: "96550333444",
      display_name: "Cloud Contact Name",
    });
  });

  it("scopes thread messages to the active connection_id", async () => {
    const client = createInMemoryWhatsAppClient({
      messages: [
        {
          id: "m-1",
          connection_id: CONNECTION_A,
          message_id: "wamid.old",
          chat_number: "96550333444",
          sent_at: "2026-11-27T10:00:00Z",
        },
        {
          id: "m-2",
          connection_id: CONNECTION_B,
          message_id: "wamid.new",
          chat_number: "96550333444",
          sent_at: "2026-11-27T11:00:00Z",
        },
      ],
    });

    const messages = await fetchWhatsAppMessagesPage(client as never, CONNECTION_B, "96550333444");
    expect(messages).toHaveLength(1);
    expect(messages[0].message_id).toBe("wamid.new");
  });

  it("scopes contacts and contact-contract links to the active connection_id", async () => {
    const client = createInMemoryWhatsAppClient({
      contacts: [
        {
          id: "c-old",
          connection_id: CONNECTION_A,
          phone: "96550111222",
          name: "Old",
          avatar_url: null,
          tenant_id: null,
          created_at: "2026-11-27T09:00:00Z",
        },
        {
          id: "c-new",
          connection_id: CONNECTION_B,
          phone: "96550333444",
          name: "Active",
          avatar_url: null,
          tenant_id: null,
          created_at: "2026-11-27T10:00:00Z",
        },
      ],
      contactContracts: [
        { connection_id: CONNECTION_A, contact_id: "c-new", contract_id: "ctr-wrong" },
        { connection_id: CONNECTION_B, contact_id: "c-new", contract_id: "ctr-right" },
      ],
    });

    const contacts = await fetchWhatsAppContacts(client as never, CONNECTION_B, "");
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe("c-new");
    expect(contacts[0].contracts).toEqual([{ id: "ctr-right", code: "—" }]);
  });

  it("returns empty arrays without querying when there is no active connection", async () => {
    const client = createInMemoryWhatsAppClient({});

    expect(await fetchWhatsAppChats(client as never, null, "")).toEqual([]);
    expect(await fetchWhatsAppMessagesPage(client as never, null, "96550333444")).toEqual([]);
    expect(await fetchWhatsAppContacts(client as never, null, "")).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });
});
