-- Restrict approval RPCs to signed-in users only.

revoke execute on function public.request_task_approval(uuid, text) from anon;
revoke execute on function public.decide_task_approval(uuid, public.approval_status, text) from anon;

grant execute on function public.request_task_approval(uuid, text) to authenticated;
grant execute on function public.decide_task_approval(uuid, public.approval_status, text) to authenticated;
