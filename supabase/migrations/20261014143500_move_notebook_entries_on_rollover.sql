create or replace function public.rollover_notebook_day(p_date date)
returns integer
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_user uuid := auth.uid();
  v_previous_date date;
  v_today date := (now() at time zone 'Europe/Sofia')::date;
  v_target_page_id uuid;
  v_next_position integer;
  v_moved integer := 0;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;

  if p_date is null then
    raise exception 'Date is required';
  end if;

  if p_date > v_today then
    return 0;
  end if;

  v_previous_date := p_date - 1;

  if not exists (
    select 1
    from public.notebook_entries e
    join public.notebook_pages p on p.id = e.page_id
    where e.user_id = v_user
      and p.user_id = v_user
      and p.page_date = v_previous_date
      and e.completed = false
      and e.source_task_id is null
  ) then
    return 0;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_user::text || ':notebook-rollover:' || p_date::text, 0)
  );

  select p.id
  into v_target_page_id
  from public.notebook_pages p
  where p.user_id = v_user
    and p.page_date = p_date
    and p.page_number = 1
  limit 1;

  if v_target_page_id is null then
    insert into public.notebook_pages(user_id, page_date, page_number)
    values (v_user, p_date, 1)
    on conflict (user_id, page_date, page_number) do nothing;

    select p.id
    into v_target_page_id
    from public.notebook_pages p
    where p.user_id = v_user
      and p.page_date = p_date
      and p.page_number = 1
    limit 1;
  end if;

  select coalesce(max(e.position), -1) + 1
  into v_next_position
  from public.notebook_entries e
  where e.page_id = v_target_page_id
    and e.user_id = v_user;

  with candidates as (
    select
      e.id,
      row_number() over (
        order by p.page_number, e.position, e.created_at, e.id
      ) - 1 as offset_position
    from public.notebook_entries e
    join public.notebook_pages p on p.id = e.page_id
    where e.user_id = v_user
      and p.user_id = v_user
      and p.page_date = v_previous_date
      and e.completed = false
      and e.source_task_id is null
  )
  update public.notebook_entries e
  set page_id = v_target_page_id,
      position = v_next_position + candidates.offset_position,
      carried_from_entry_id = null,
      carried_from_date = v_previous_date,
      updated_at = now()
  from candidates
  where e.id = candidates.id;

  get diagnostics v_moved = row_count;
  return v_moved;
end;
$function$;
