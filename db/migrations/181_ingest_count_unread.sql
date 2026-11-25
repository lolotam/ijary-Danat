-- 181_ingest_count_unread.sql
-- Re-issues ingest_whatsapp_messages (180) with one addition: a row may carry
-- `count_unread: false`, which stores the message and advances the chat
-- preview without touching unread_count. The history-sync sweep uses it —
-- importing a year of old chats must not light the inbox badge with hundreds
-- of "unread" messages the admin read on their phone long ago. Webhook rows
-- omit the field and default to true, so live behaviour is unchanged.
-- Same signature as 180, so `create or replace` is safe and idempotent.

create or replace function public.ingest_whatsapp_messages(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  inserted_id uuid;
  inserted_count integer := 0;
  v_sent_at timestamptz;
  v_from_me boolean;
  v_count_unread boolean;
  v_preview text;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_sent_at := coalesce((r->>'sent_at')::timestamptz, now());
    v_from_me := coalesce((r->>'from_me')::boolean, false);
    v_count_unread := coalesce((r->>'count_unread')::boolean, true) and not v_from_me;

    insert into public.whatsapp_messages
      (message_id, chat_number, direction, from_me, body, message_type,
       media_type, media_id, media_filename, sent_at, raw)
    values
      (r->>'message_id',
       r->>'chat_number',
       r->>'direction',
       v_from_me,
       r->>'body',
       coalesce(r->>'message_type', 'text'),
       r->>'media_type',
       r->>'media_id',
       r->>'media_filename',
       v_sent_at,
       r->'raw')
    on conflict (message_id) do nothing
    returning id into inserted_id;

    if inserted_id is null then
      continue;  -- replay of a message we already hold
    end if;
    inserted_count := inserted_count + 1;

    v_preview := coalesce(
      nullif(trim(r->>'body'), ''),
      '[' || coalesce(r->>'media_type', r->>'message_type', 'message') || ']'
    );

    insert into public.whatsapp_chats
      (chat_number, display_name, last_message_preview, last_message_at, unread_count)
    values
      (r->>'chat_number',
       nullif(trim(r->>'push_name'), ''),
       v_preview,
       v_sent_at,
       case when v_count_unread then 1 else 0 end)
    on conflict (chat_number) do update
      set last_message_preview = case
            when excluded.last_message_at >= coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz)
            then excluded.last_message_preview
            else whatsapp_chats.last_message_preview
          end,
          last_message_at = greatest(
            coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz),
            excluded.last_message_at
          ),
          -- Fill-empty only: a push name never overwrites an admin-set name.
          display_name = coalesce(whatsapp_chats.display_name, excluded.display_name),
          unread_count = whatsapp_chats.unread_count + case when v_count_unread then 1 else 0 end,
          updated_at = now();

    -- Contact auto-capture, same fill-empty-only rule for the name.
    insert into public.whatsapp_contacts (phone, name)
    values (r->>'chat_number', nullif(trim(r->>'push_name'), ''))
    on conflict (phone) do update
      set name = coalesce(whatsapp_contacts.name, excluded.name),
          updated_at = now();
  end loop;

  return inserted_count;
end;
$$;

-- Grants re-stated so re-applying 180 then 181 always lands in the same place.
revoke all on function public.ingest_whatsapp_messages(jsonb) from public;
revoke all on function public.ingest_whatsapp_messages(jsonb) from anon;
revoke all on function public.ingest_whatsapp_messages(jsonb) from authenticated;
grant execute on function public.ingest_whatsapp_messages(jsonb) to service_role;
