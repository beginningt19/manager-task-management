-- Harden task approval workflow.
-- Applied to Supabase as migration: harden_task_approval_workflow

create unique index if not exists approvals_one_pending_per_task
  on public.approvals(task_id)
  where status = 'pending'::public.approval_status;

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
  task_approval_required boolean;
  current_status public.task_status;
  created_approval_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  if not (select private.is_active_user()) then
    raise exception 'Active profile required' using errcode='42501';
  end if;

  select t.approval_required, t.status
    into task_approval_required, current_status
  from public.tasks t
  where t.id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found' using errcode='P0002';
  end if;

  if not ((select private.is_manager()) or (select private.is_task_assignee(p_task_id))) then
    raise exception 'Only a task participant can request approval' using errcode='42501';
  end if;

  if not task_approval_required then
    raise exception 'This task does not require approval' using errcode='23514';
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
  set status = 'waiting_approval'::public.task_status
  where id = p_task_id;

  return created_approval_id;
end;
$function$;

revoke all on function public.request_task_approval(uuid, text) from public;
grant execute on function public.request_task_approval(uuid, text) to authenticated;

create or replace function public.decide_task_approval(
  p_approval_id uuid,
  p_status public.approval_status,
  p_decision_note text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  caller_id uuid := (select auth.uid());
  target_task_id uuid;
  current_approval_status public.approval_status;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  if not (select private.is_governor()) then
    raise exception 'Only the governor can decide task approvals' using errcode='42501';
  end if;

  if p_status is null or p_status = 'pending'::public.approval_status then
    raise exception 'A final approval decision is required' using errcode='23514';
  end if;

  select a.task_id, a.status
    into target_task_id, current_approval_status
  from public.approvals a
  where a.id = p_approval_id
  for update;

  if not found then
    raise exception 'Approval request not found' using errcode='P0002';
  end if;

  if current_approval_status <> 'pending'::public.approval_status then
    raise exception 'This approval request has already been decided' using errcode='23514';
  end if;

  update public.approvals
  set status = p_status,
      reviewer_id = caller_id,
      decision_note = nullif(trim(coalesce(p_decision_note, '')), ''),
      decided_at = now()
  where id = p_approval_id;

  update public.tasks
  set status = 'in_progress'::public.task_status
  where id = target_task_id
    and status = 'waiting_approval'::public.task_status;
end;
$function$;

revoke all on function public.decide_task_approval(uuid, public.approval_status, text) from public;
grant execute on function public.decide_task_approval(uuid, public.approval_status, text) to authenticated;

create or replace function private.enforce_latest_task_approval_before_completion()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  latest_status public.approval_status;
begin
  if new.status = 'completed'::public.task_status
     and old.status <> 'completed'::public.task_status
     and new.approval_required then

    select a.status
      into latest_status
    from public.approvals a
    where a.task_id = new.id
    order by a.requested_at desc, a.id desc
    limit 1;

    if latest_status is distinct from 'approved'::public.approval_status then
      raise exception 'The latest approval request must be approved before the task can be completed'
        using errcode='23514';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists tasks_require_latest_approval_for_completion on public.tasks;
create trigger tasks_require_latest_approval_for_completion
before update of status on public.tasks
for each row
execute function private.enforce_latest_task_approval_before_completion();
