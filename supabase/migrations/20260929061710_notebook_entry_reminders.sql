alter table public.task_reminders
  alter column task_id drop not null;

alter table public.task_reminders
  add column if not exists notebook_entry_id uuid
    references public.notebook_entries(id) on delete cascade;

alter table public.task_reminders
  add constraint task_reminders_notebook_entry_id_key unique (notebook_entry_id);

alter table public.task_reminders
  add constraint task_reminders_exactly_one_target_check
  check ((task_id is not null) <> (notebook_entry_id is not null));

create index if not exists task_reminders_notebook_entry_id_idx
  on public.task_reminders(notebook_entry_id)
  where notebook_entry_id is not null;

drop policy if exists task_reminders_creator_insert on public.task_reminders;
drop policy if exists task_reminders_creator_update on public.task_reminders;
drop policy if exists task_reminders_creator_delete on public.task_reminders;
drop policy if exists task_reminders_visibility_mode on public.task_reminders;

create policy task_reminders_creator_insert
on public.task_reminders
for insert
to authenticated
with check (
  private.is_active_user()
  and created_by = (select auth.uid())
  and remind_at > now()
  and (
    (
      task_id is not null
      and notebook_entry_id is null
      and exists (
        select 1 from public.tasks t
        where t.id = task_reminders.task_id
          and t.created_by = (select auth.uid())
      )
    )
    or
    (
      notebook_entry_id is not null
      and task_id is null
      and exists (
        select 1 from public.notebook_entries n
        where n.id = task_reminders.notebook_entry_id
          and n.user_id = (select auth.uid())
      )
    )
  )
);

create policy task_reminders_creator_update
on public.task_reminders
for update
to authenticated
using (
  private.is_active_user()
  and created_by = (select auth.uid())
  and (
    (
      task_id is not null
      and exists (
        select 1 from public.tasks t
        where t.id = task_reminders.task_id
          and t.created_by = (select auth.uid())
      )
    )
    or
    (
      notebook_entry_id is not null
      and exists (
        select 1 from public.notebook_entries n
        where n.id = task_reminders.notebook_entry_id
          and n.user_id = (select auth.uid())
      )
    )
  )
)
with check (
  private.is_active_user()
  and created_by = (select auth.uid())
  and remind_at > now()
  and (
    (
      task_id is not null
      and notebook_entry_id is null
      and exists (
        select 1 from public.tasks t
        where t.id = task_reminders.task_id
          and t.created_by = (select auth.uid())
      )
    )
    or
    (
      notebook_entry_id is not null
      and task_id is null
      and exists (
        select 1 from public.notebook_entries n
        where n.id = task_reminders.notebook_entry_id
          and n.user_id = (select auth.uid())
      )
    )
  )
);

create policy task_reminders_creator_delete
on public.task_reminders
for delete
to authenticated
using (
  private.is_active_user()
  and created_by = (select auth.uid())
  and (
    (
      task_id is not null
      and exists (
        select 1 from public.tasks t
        where t.id = task_reminders.task_id
          and t.created_by = (select auth.uid())
      )
    )
    or
    (
      notebook_entry_id is not null
      and exists (
        select 1 from public.notebook_entries n
        where n.id = task_reminders.notebook_entry_id
          and n.user_id = (select auth.uid())
      )
    )
  )
);

create policy task_reminders_visibility_mode
on public.task_reminders
for select
to authenticated
using (
  (
    task_id is not null
    and (select private.can_view_task(task_reminders.task_id))
    and (
      created_by = (select auth.uid())
      or private.is_task_assignee(task_id)
    )
  )
  or
  (
    notebook_entry_id is not null
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.notebook_entries n
      where n.id = task_reminders.notebook_entry_id
        and n.user_id = (select auth.uid())
    )
  )
);

create or replace function private.dispatch_mobile_push_event()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'extensions', 'pg_temp'
as $function$
declare
  reminder_id uuid;
  task_id_value uuid;
  notebook_entry_id_value uuid;
  remind_at_value timestamptz;
  reminder_creator uuid;
  action_value text;
  description_value text;
  notebook_user_id uuid;
  recipient_ids jsonb;
  dispatch_token text;
begin
  if tg_op='DELETE' then
    reminder_id:=old.id;
    task_id_value:=old.task_id;
    notebook_entry_id_value:=old.notebook_entry_id;
    remind_at_value:=old.remind_at;
    reminder_creator:=old.created_by;
    action_value:='delete';
  else
    reminder_id:=new.id;
    task_id_value:=new.task_id;
    notebook_entry_id_value:=new.notebook_entry_id;
    remind_at_value:=new.remind_at;
    reminder_creator:=new.created_by;
    action_value:='upsert';
  end if;

  if notebook_entry_id_value is not null then
    select n.user_id, n.body
      into notebook_user_id, description_value
    from public.notebook_entries n
    where n.id = notebook_entry_id_value;

    recipient_ids := jsonb_build_array(coalesce(notebook_user_id, reminder_creator)::text);
    description_value := coalesce(description_value, 'Запис от тефтера');
  else
    select coalesce(jsonb_agg(distinct ta.user_id::text),'[]'::jsonb)
      into recipient_ids
    from public.task_assignees ta
    where ta.task_id=task_id_value;

    if jsonb_array_length(recipient_ids)=0 then
      recipient_ids:=jsonb_build_array(reminder_creator::text);
    end if;

    select t.description into description_value
    from public.tasks t
    where t.id=task_id_value;

    description_value := coalesce(description_value,'Задача');
  end if;

  select token into dispatch_token
  from public.internal_dispatch_tokens
  where name='mobile-push-dispatch';

  if dispatch_token is null then
    return coalesce(new,old);
  end if;

  perform net.http_post(
    url := 'https://xrcvfzqwhqtoljfxgxgr.supabase.co/functions/v1/send-mobile-push',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-mobile-push-token',dispatch_token
    ),
    body := jsonb_build_object(
      'type','task-reminder-sync',
      'action',action_value,
      'reminder_id',reminder_id,
      'task_id',task_id_value,
      'remind_at',remind_at_value,
      'description',description_value,
      'recipient_user_ids',recipient_ids
    )
  );

  return coalesce(new,old);
end;
$function$;

drop trigger if exists task_reminders_mobile_push_event on public.task_reminders;
create trigger task_reminders_mobile_push_event
after insert or delete or update of remind_at, task_id, notebook_entry_id
on public.task_reminders
for each row
execute function private.dispatch_mobile_push_event();

create or replace function public.notifier_fetch_due_reminders(
  p_device_token text,
  p_from timestamp with time zone,
  p_to timestamp with time zone
)
returns table(
  id uuid,
  task_id uuid,
  remind_at timestamp with time zone,
  tasks jsonb
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid;
begin
  v_user_id := private.require_notifier_device_user(p_device_token);

  return query
  select
    r.id,
    r.task_id,
    r.remind_at,
    jsonb_build_object(
      'description', coalesce(t.description, n.body, 'Напомняне'),
      'status',
        case
          when n.id is not null then case when n.completed then 'completed' else 'notebook' end
          else t.status::text
        end,
      'completed_at',
        case
          when n.id is not null and n.completed then n.updated_at
          else t.completed_at
        end,
      'kind', case when n.id is not null then 'notebook' else 'task' end,
      'notebook_entry_id', n.id
    ) as tasks
  from public.task_reminders r
  left join public.tasks t on t.id = r.task_id
  left join public.notebook_entries n on n.id = r.notebook_entry_id
  where r.remind_at >= p_from
    and r.remind_at <= p_to
    and (
      (
        r.task_id is not null
        and exists (
          select 1
          from public.task_assignees a
          where a.task_id = r.task_id
            and a.user_id = v_user_id
        )
      )
      or
      (
        r.notebook_entry_id is not null
        and r.created_by = v_user_id
        and n.user_id = v_user_id
      )
    )
  order by r.remind_at asc;
end;
$function$;
