-- Make approval requests authoritative even for tasks that were not
-- originally created with approval_required=true, and block stale clients
-- from setting waiting_approval without a real pending approval row.

create or replace function public.restrict_assignee_task_update()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  actor_id uuid := auth.uid();
  approval_escalation boolean := false;
begin
  if new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.recurrence_id is distinct from old.recurrence_id then
    raise exception 'Task identity fields cannot be changed';
  end if;

  if actor_id is not null and actor_id is distinct from old.created_by then
    approval_escalation :=
      old.approval_required = false
      and new.approval_required = true
      and new.status = 'waiting_approval'::public.task_status
      and exists (
        select 1
        from public.approvals a
        where a.task_id = old.id
          and a.status = 'pending'::public.approval_status
          and a.requested_by = actor_id
      );

    if new.description is distinct from old.description
       or new.due_at is distinct from old.due_at
       or new.priority is distinct from old.priority
       or new.required_materials is distinct from old.required_materials
       or (
         new.approval_required is distinct from old.approval_required
         and not approval_escalation
       ) then
      raise exception 'Only the task creator may edit task details';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function public.request_task_approval(
  p_task_id uuid,
  p_request_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  caller_id uuid := (select auth.uid());
  current_status public.task_status;
  created_approval_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  if not (select private.is_active_user()) then
    raise exception 'Active profile required' using errcode='42501';
  end if;

  select t.status
    into current_status
  from public.tasks t
  where t.id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found' using errcode='P0002';
  end if;

  if not ((select private.is_manager()) or (select private.is_task_assignee(p_task_id))) then
    raise exception 'Only a task participant can request approval' using errcode='42501';
  end if;

  if current_status = 'new'::public.task_status then
    raise exception 'The task must be accepted before approval can be requested' using errcode='23514';
  end if;

  if current_status = 'completed'::public.task_status then
    raise exception 'A completed task cannot be sent for approval' using errcode='23514';
  end if;

  if exists (
    select 1
    from public.approvals a
    where a.task_id = p_task_id
      and a.status = 'pending'::public.approval_status
  ) then
    raise exception 'This task already has a pending approval request' using errcode='23505';
  end if;

  insert into public.approvals(task_id, requested_by, request_note)
  values (
    p_task_id,
    caller_id,
    nullif(trim(coalesce(p_request_note, '')), '')
  )
  returning id into created_approval_id;

  update public.tasks
  set approval_required = true,
      status = 'waiting_approval'::public.task_status
  where id = p_task_id;

  return created_approval_id;
end;
$function$;

create or replace function private.enforce_waiting_approval_consistency()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.status = 'waiting_approval'::public.task_status then
    if not new.approval_required then
      raise exception 'A task waiting for approval must require approval'
        using errcode='23514';
    end if;

    if not exists (
      select 1
      from public.approvals a
      where a.task_id = new.id
        and a.status = 'pending'::public.approval_status
    ) then
      raise exception 'A task cannot wait for approval without a pending approval request'
        using errcode='23514';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists tasks_waiting_approval_consistency on public.tasks;
create trigger tasks_waiting_approval_consistency
before update of status, approval_required on public.tasks
for each row
execute function private.enforce_waiting_approval_consistency();

revoke execute on function public.request_task_approval(uuid, text) from anon;
grant execute on function public.request_task_approval(uuid, text) to authenticated;
