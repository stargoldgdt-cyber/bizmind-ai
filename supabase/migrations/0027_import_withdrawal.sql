-- ============================================================================
-- 0027  Withdrawing an import
-- ============================================================================
-- Step A gave every record a written history of the imports, syncs and direct
-- edits that wrote it. This is what that history was for: an owner can take an
-- import back out of their business data, and BizMind can say exactly what
-- that will and will not touch BEFORE anything happens.
--
-- WITHDRAWN, NOT DELETED (the owner's decision, 2026-09-12)
--   - the records stop counting towards every figure (migration 0025 already
--     excludes them everywhere)
--   - the import, its rows, its row problems and its lineage all remain
--   - it can be restored
--   - nothing another import, sync or person also wrote is touched
--
-- THE RULE
--   A record is withdrawn only if EVERY other write to it came from an import
--   that is itself already withdrawn. Any other active import, any sync, any
--   direct edit, or an origin that could not be traced (UNTRACED) makes it
--   shared -- and shared records stay exactly as they are.
--
-- WHAT WITHDRAWAL CANNOT DO
--   A record this import UPDATED keeps the values this import wrote, because
--   BizMind keeps no earlier version of a record. The preview says so in
--   words, so nobody expects a rollback they are not getting.
--
-- Only an owner or admin, only their own business, always audited.
--
-- Depends on 0024-0026. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The Data Sources list
-- ----------------------------------------------------------------------------
-- One row per import, with what it wrote and what is known about it. SECURITY
-- INVOKER, so Row Level Security decides which imports the caller can see.

create function public.import_batch_overview(
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  batch_id          uuid,
  business_id       uuid,
  entity            public.import_entity,
  status            public.import_status,
  source            public.channel_type,
  file_name         text,
  file_type         text,
  created_at        timestamptz,
  committed_at      timestamptz,
  row_count         integer,
  rows_valid        integer,
  rows_failed       integer,
  created_count     integer,
  updated_count     integer,
  errors_count      bigint,
  warnings_count    bigint,
  lineage_status    text,
  records_written   bigint,
  records_withdrawn bigint,
  withdrawn_at      timestamptz,
  withdrawal_reason text,
  connection_name   text,
  matched_count     bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with visible as (
  select b.* from public.import_batches b
),
counted as (select count(*) as total from visible)
select
  b.id,
  b.business_id,
  b.entity,
  b.status,
  b.source,
  b.file_name,
  b.file_type,
  b.created_at,
  b.committed_at,
  b.row_count,
  b.rows_valid,
  b.rows_failed,
  b.created_count,
  b.updated_count,
  (select count(*) from public.import_issues i
    where i.batch_id = b.id and i.severity = 'ERROR')                as errors_count,
  (select count(*) from public.import_issues i
    where i.batch_id = b.id and i.severity = 'WARNING')              as warnings_count,
  b.lineage_status,
  (select count(*) from public.record_lineage l where l.batch_id = b.id)
                                                                     as records_written,
  (select count(*) from public.orders o where o.withdrawn_by_batch = b.id)
  + (select count(*) from public.products p where p.withdrawn_by_batch = b.id)
  + (select count(*) from public.expenses e where e.withdrawn_by_batch = b.id)
                                                                     as records_withdrawn,
  b.withdrawn_at,
  b.withdrawal_reason,
  a.display_name                                                     as connection_name,
  (select total from counted)                                        as matched_count
from visible b
left join public.integration_accounts a on a.id = b.integration_account_id
order by b.created_at desc
limit greatest(p_limit, 1)
offset greatest(p_offset, 0);
$$;


-- ----------------------------------------------------------------------------
-- 2. What withdrawing would do
-- ----------------------------------------------------------------------------
-- Read-only. Called before the confirmation is shown, and again inside the
-- withdrawal itself, so the figures an owner agreed to are the figures acted
-- on rather than a stale count from a minute ago.

create function public.import_batch_withdrawal_preview(p_batch_id uuid)
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
    (select count(*) from judged where how = 'CREATED'),
    (select count(*) from judged where how in ('UPDATED', 'RECOVERED')),
    (select count(*) from judged where not shared),
    (select count(*) from judged where shared),
    (select count(*) from judged where not shared and entity = 'ORDER'),
    (select count(*) from judged where not shared and entity = 'PRODUCT'),
    (select count(*) from judged where not shared and entity = 'EXPENSE'),
    (select coalesce(array_agg(label), '{}') from others);
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. Withdraw
-- ----------------------------------------------------------------------------

create function public.import_batch_withdraw(
  p_batch_id uuid,
  p_reason   text default null
)
returns table (
  orders_withdrawn   bigint,
  products_withdrawn bigint,
  expenses_withdrawn bigint,
  records_shared     bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch    public.import_batches;
  v_orders   bigint := 0;
  v_products bigint := 0;
  v_expenses bigint := 0;
  v_shared   bigint := 0;
begin
  select * into v_batch from public.import_batches where id = p_batch_id for update;

  -- Not a member of this import's business: it does not exist, as far as this
  -- caller is concerned. See the note in the preview function.
  if v_batch.id is null
     or v_batch.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That import could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_batch.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can withdraw an import.'
      using errcode = '42501';
  end if;

  if v_batch.withdrawn_at is not null then
    raise exception 'This import has already been withdrawn.' using errcode = 'P0001';
  end if;

  if v_batch.lineage_status not in ('RECORDED', 'RECOVERED') then
    raise exception
      'BizMind cannot tell exactly what this import wrote, so withdrawing it could remove data another source owns.'
      using errcode = 'P0001';
  end if;

  -- The markers are guarded by a trigger (0024); this is the key.
  perform set_config('bizmind.lineage_writer', 'on', true);

  create temporary table withdrawing on commit drop as
  with mine as (
    select l.entity, l.record_id from public.record_lineage l where l.batch_id = p_batch_id
  )
  select
    m.entity,
    m.record_id,
    exists (
      select 1
      from public.record_lineage o
      left join public.import_batches b on b.id = o.batch_id
      where o.entity = m.entity
        and o.record_id = m.record_id
        and o.batch_id is distinct from p_batch_id
        and (o.batch_id is null or b.withdrawn_at is null)
    ) as shared
  from mine m;

  select count(*) into v_shared from withdrawing where shared;

  update public.orders o
  set withdrawn_at = now(), withdrawn_by_batch = p_batch_id
  from withdrawing w
  where w.entity = 'ORDER'
    and not w.shared
    and o.id = w.record_id
    and o.business_id = v_batch.business_id
    and o.withdrawn_at is null;
  get diagnostics v_orders = row_count;

  update public.products p
  set withdrawn_at = now(), withdrawn_by_batch = p_batch_id
  from withdrawing w
  where w.entity = 'PRODUCT'
    and not w.shared
    and p.id = w.record_id
    and p.business_id = v_batch.business_id
    and p.withdrawn_at is null;
  get diagnostics v_products = row_count;

  update public.expenses e
  set withdrawn_at = now(), withdrawn_by_batch = p_batch_id
  from withdrawing w
  where w.entity = 'EXPENSE'
    and not w.shared
    and e.id = w.record_id
    and e.business_id = v_batch.business_id
    and e.withdrawn_at is null;
  get diagnostics v_expenses = row_count;

  update public.import_batches
  set withdrawn_at      = now(),
      withdrawn_by      = (select auth.uid()),
      withdrawal_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_batch_id;

  perform public.write_audit_log(
    v_batch.business_id,
    'import.withdrawn',
    'import_batches',
    p_batch_id,
    jsonb_build_object('file_name', v_batch.file_name, 'entity', v_batch.entity),
    jsonb_build_object(
      'orders_withdrawn', v_orders,
      'products_withdrawn', v_products,
      'expenses_withdrawn', v_expenses,
      'records_left_shared', v_shared,
      'reason', p_reason
    )
  );

  return query select v_orders, v_products, v_expenses, v_shared;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Restore
-- ----------------------------------------------------------------------------
-- Only the records THIS import withdrew, and only those still marked by it. A
-- record another import has since written again was already brought back by
-- that write (0024 clears the markers on any import write), so there is
-- nothing here to undo for it.

create function public.import_batch_restore(p_batch_id uuid)
returns table (
  orders_restored   bigint,
  products_restored bigint,
  expenses_restored bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch    public.import_batches;
  v_orders   bigint := 0;
  v_products bigint := 0;
  v_expenses bigint := 0;
begin
  select * into v_batch from public.import_batches where id = p_batch_id for update;

  -- Not a member of this import's business: it does not exist, as far as this
  -- caller is concerned. See the note in the preview function.
  if v_batch.id is null
     or v_batch.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That import could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_batch.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can restore an import.'
      using errcode = '42501';
  end if;

  if v_batch.withdrawn_at is null then
    raise exception 'This import is not withdrawn.' using errcode = 'P0001';
  end if;

  perform set_config('bizmind.lineage_writer', 'on', true);

  update public.orders set withdrawn_at = null, withdrawn_by_batch = null
  where withdrawn_by_batch = p_batch_id and business_id = v_batch.business_id;
  get diagnostics v_orders = row_count;

  update public.products set withdrawn_at = null, withdrawn_by_batch = null
  where withdrawn_by_batch = p_batch_id and business_id = v_batch.business_id;
  get diagnostics v_products = row_count;

  update public.expenses set withdrawn_at = null, withdrawn_by_batch = null
  where withdrawn_by_batch = p_batch_id and business_id = v_batch.business_id;
  get diagnostics v_expenses = row_count;

  update public.import_batches
  set withdrawn_at = null, withdrawn_by = null, withdrawal_reason = null
  where id = p_batch_id;

  perform public.write_audit_log(
    v_batch.business_id,
    'import.restored',
    'import_batches',
    p_batch_id,
    jsonb_build_object('withdrawn_at', v_batch.withdrawn_at),
    jsonb_build_object(
      'orders_restored', v_orders,
      'products_restored', v_products,
      'expenses_restored', v_expenses
    )
  );

  return query select v_orders, v_products, v_expenses;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Privileges
-- ----------------------------------------------------------------------------

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.import_batch_overview(integer, integer)',
    'public.import_batch_withdrawal_preview(uuid)',
    'public.import_batch_withdraw(uuid, text)',
    'public.import_batch_restore(uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', v_sig);
    execute format('grant execute on function %s to authenticated', v_sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_fn  text;
  v_src text;
begin
  foreach v_fn in array array[
    'import_batch_overview', 'import_batch_withdrawal_preview',
    'import_batch_withdraw', 'import_batch_restore'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: authenticated cannot execute public.%().', v_fn;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute public.%().', v_fn;
    end if;
  end loop;

  -- The three that change data must check the caller's role themselves: they
  -- are SECURITY DEFINER, so RLS is not doing it for them.
  foreach v_fn in array array[
    'import_batch_withdrawal_preview', 'import_batch_withdraw', 'import_batch_restore'
  ]
  loop
    select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if position('current_user_has_role' in v_src) = 0 then
      raise exception 'SECURITY: %() does not check the caller''s role.', v_fn;
    end if;
  end loop;

  raise notice
    'Migration 0027 verified: withdrawal previews, withdraws and restores are '
    'owner-or-admin only, tenant-scoped, audited, and never touch a record '
    'another source also wrote.';
end;
$$;


commit;
