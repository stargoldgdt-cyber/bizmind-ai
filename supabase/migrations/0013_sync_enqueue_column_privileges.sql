-- ============================================================================
-- 0013  sync_enqueue: read only the columns it is allowed to read
-- ============================================================================
-- A follow-up to 0012, which is already applied. Nothing else changes.
--
-- WHAT WENT WRONG
-- ---------------
-- Migration 0012 stopped granting `authenticated` a table-wide SELECT on
-- integration_accounts, so the two credential columns are unreadable. That is
-- the point of it, and it works.
--
-- But `sync_enqueue()` is SECURITY INVOKER -- it runs as the signed-in user --
-- and it began with:
--
--     select * into v_account from public.integration_accounts where id = ...
--
-- `SELECT *` needs SELECT on EVERY column, including the two it has no
-- business reading. So the privilege fix broke it:
--
--     42501 permission denied for table integration_accounts
--
-- The database even suggested the wrong repair:
--
--     HINT: GRANT SELECT ON public.integration_accounts TO authenticated;
--
-- Following that hint would undo the security fix entirely and hand every
-- owner their own encrypted tokens back. The hint is generic; it does not
-- know that two of those columns are secret.
--
-- THE FIX
-- -------
-- Read the two columns the function actually uses. It needs the business, to
-- check the caller's role, and the status, to refuse a disconnected store.
-- It never needed the rest.
--
-- It stays SECURITY INVOKER deliberately. Its sibling
-- `integration_account_connect()` had to become DEFINER because it returns the
-- whole row; this one does not, so it keeps the stronger boundary: RLS scopes
-- the lookup, and an account id belonging to another business finds nothing at
-- all rather than being found and then rejected.
--
-- The same correction is in 0012 for a fresh install, so both paths end in the
-- same place.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.sync_enqueue(
  p_account_id uuid,
  p_resource   text,
  p_mode       public.sync_mode default 'INCREMENTAL',
  p_priority   smallint default 100
)
returns public.sync_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_business_id uuid;
  v_status      public.integration_status;
  v_job         public.sync_jobs;
begin
  -- Two named columns, not `*`. Two scalars in one INTO list is fine; it is a
  -- RECORD variable that may not share the list (see 0012's own history).
  --
  -- RLS applies here, so an account belonging to another business is not
  -- found. The role check below is a second boundary, not the only one.
  select a.business_id, a.status into v_business_id, v_status
  from public.integration_accounts a
  where a.id = p_account_id;

  if v_business_id is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can start a sync.'
      using errcode = '42501';
  end if;

  if v_status = 'DISCONNECTED' then
    raise exception 'That connection has been disconnected.' using errcode = 'P0001';
  end if;

  insert into public.sync_jobs (
    business_id, integration_account_id, resource, mode, status,
    priority, next_run_at
  )
  values (
    v_business_id, p_account_id, p_resource, p_mode, 'QUEUED',
    p_priority, now()
  )
  on conflict (integration_account_id, resource) do update set
    status      = 'QUEUED',
    mode        = excluded.mode,
    -- A fresh INITIAL sync starts over; an incremental one keeps its place.
    cursor      = case when excluded.mode = 'INITIAL' then null
                       else public.sync_jobs.cursor end,
    attempts    = 0,
    next_run_at = now(),
    last_error  = null,
    locked_at   = null,
    locked_until = null,
    locked_by   = null
  returning * into v_job;

  perform public.write_audit_log(
    v_business_id, 'integration.sync.enqueued', 'sync_jobs', v_job.id,
    null, jsonb_build_object('resource', p_resource, 'mode', p_mode)
  );

  return v_job;
end;
$$;

revoke all on function public.sync_enqueue(uuid, text, public.sync_mode, smallint)
  from anon, public;
grant execute on function public.sync_enqueue(uuid, text, public.sync_mode, smallint)
  to authenticated;


-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_body text;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_enqueue'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'authenticated cannot execute sync_enqueue()';
  end if;

  -- The credential columns must still be unreadable. If a well-meaning
  -- follow-up ever takes the database's HINT and grants table-wide SELECT,
  -- this is where it gets caught.
  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'credentials_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integration_accounts.credentials_encrypted. '
      'Something granted a table-wide SELECT -- a column-level revoke will not '
      'undo it. Grant the columns individually instead.';
  end if;

  -- And the function must no longer read the whole row.
  select pg_get_functiondef(p.oid) into v_body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sync_enqueue';

  if v_body like '%select * into v_account%' then
    raise exception 'sync_enqueue() still reads every column.';
  end if;

  raise notice
    'Migration 0013 verified: sync_enqueue reads only what it may, and the '
    'credential columns remain unreadable.';
end;
$$;

commit;
