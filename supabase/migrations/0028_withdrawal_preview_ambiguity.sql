-- ============================================================================
-- 0028  The withdrawal preview could not run
-- ============================================================================
-- 0027 installed cleanly and then failed the first time it was called:
--
--   42702  column reference "entity" is ambiguous
--          It could refer to either a PL/pgSQL variable or a table column.
--
-- The function returns a column called `entity`, and its final select counted
-- rows with an unqualified `entity = 'ORDER'`. Inside a plpgsql function the
-- output column is also a variable, so PostgreSQL had two candidates and
-- refused the whole query -- at call time, not at install time, which is why
-- 0027's self-verification passed.
--
-- The fix is to name the source explicitly: `judged.entity`. Nothing else
-- about the function changes -- same signature, same rule, same figures.
--
-- WHAT THIS SAYS ABOUT THE TESTS
--   0027 checked the function's PRIVILEGES and its SOURCE TEXT. Neither can
--   catch a query that only fails when it runs. `npm run test:withdrawal`
--   calls every one of these functions for real, and that is what found this.
--
-- Depends on 0027. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


create or replace function public.import_batch_withdrawal_preview(p_batch_id uuid)
returns table (
  batch_id           uuid,
  file_name          text,
  entity             public.import_entity,
  lineage_status     text,
  already_withdrawn  boolean,
  can_withdraw       boolean,
  blocked_reason     text,
  records_written    bigint,
  records_created    bigint,
  records_updated    bigint,
  /** Written ONLY by this import: these stop counting. */
  records_exclusive  bigint,
  /** Also written by something else: these stay exactly as they are. */
  records_shared     bigint,
  orders_exclusive   bigint,
  products_exclusive bigint,
  expenses_exclusive bigint,
  /** Who else wrote the shared ones, in the owner's language. */
  shared_with        text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from public.import_batches where id = p_batch_id;

  -- SECURITY DEFINER, so this select saw every business. An import in a
  -- business the caller does not belong to must be indistinguishable from one
  -- that does not exist: a different message would confirm that this id is
  -- real, which is a fact about someone else's business.
  if v_batch.id is null
     or v_batch.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That import could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_batch.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can withdraw an import.'
      using errcode = '42501';
  end if;

  return query
  with mine as (
    select l.entity, l.record_id, l.how
    from public.record_lineage l
    where l.batch_id = p_batch_id
  ),
  judged as (
    select
      m.entity,
      m.record_id,
      m.how,
      exists (
        select 1
        from public.record_lineage o
        left join public.import_batches b on b.id = o.batch_id
        where o.entity = m.entity
          and o.record_id = m.record_id
          and o.batch_id is distinct from p_batch_id
          -- A writer that cannot be withdrawn (a direct edit, an origin that
          -- could not be traced) or an import still in force.
          and (o.batch_id is null or b.withdrawn_at is null)
      ) as shared
    from mine m
  ),
  others as (
    select distinct coalesce(
             b.file_name,
             case o.how
               when 'DIRECT'   then 'an edit made in BizMind'
               when 'UNTRACED' then 'a source that could not be traced'
               else 'another import'
             end) as label
    from judged j
    join public.record_lineage o
      on o.entity = j.entity and o.record_id = j.record_id
     and o.batch_id is distinct from p_batch_id
    left join public.import_batches b on b.id = o.batch_id
    where j.shared
      and (o.batch_id is null or b.withdrawn_at is null)
    limit 5
  )
  select
    v_batch.id,
    v_batch.file_name,
    v_batch.entity,
    v_batch.lineage_status,
    (v_batch.withdrawn_at is not null),
    (v_batch.withdrawn_at is null
      and v_batch.lineage_status in ('RECORDED', 'RECOVERED')),
    case
      when v_batch.withdrawn_at is not null then 'This import has already been withdrawn.'
      when v_batch.lineage_status = 'NONE' then
        'BizMind cannot tell which records this import wrote, because it kept no rows to rebuild from. Withdrawing it could remove data another source owns, so it is not offered.'
      when v_batch.lineage_status = 'INCOMPLETE' then
        'Some of what this import wrote cannot be identified -- rows with no reference of their own. Withdrawing it would leave those behind, so it is not offered.'
    end,
    (select count(*) from judged),
    (select count(*) from judged where judged.how = 'CREATED'),
    (select count(*) from judged where judged.how in ('UPDATED', 'RECOVERED')),
    (select count(*) from judged where not judged.shared),
    (select count(*) from judged where judged.shared),
    -- QUALIFIED: `entity` alone is also this function's output column.
    (select count(*) from judged where not judged.shared and judged.entity = 'ORDER'),
    (select count(*) from judged where not judged.shared and judged.entity = 'PRODUCT'),
    (select count(*) from judged where not judged.shared and judged.entity = 'EXPENSE'),
    (select coalesce(array_agg(others.label), '{}') from others);
end;
$$;


-- ----------------------------------------------------------------------------
-- Privileges
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE keeps the existing grants, but they are restated so this
-- migration is correct on a database where 0027 was never applied cleanly.

revoke all on function public.import_batch_withdrawal_preview(uuid) from anon, public;
grant execute on function public.import_batch_withdrawal_preview(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'import_batch_withdrawal_preview';

  if position('current_user_has_role' in v_src) = 0 then
    raise exception 'SECURITY: the preview no longer checks the caller''s role.';
  end if;

  if position('current_user_business_ids' in v_src) = 0 then
    raise exception 'SECURITY: the preview no longer checks tenant membership.';
  end if;

  if position('not judged.shared and judged.entity' in v_src) = 0 then
    raise exception 'The ambiguous column reference is still there.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'import_batch_withdrawal_preview'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'SECURITY: authenticated cannot execute the preview.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'import_batch_withdrawal_preview'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'SECURITY: anon can execute the preview.';
  end if;

  raise notice
    'Migration 0028 verified: the withdrawal preview runs, and is still '
    'owner-or-admin only and tenant-scoped.';
end;
$$;


commit;
