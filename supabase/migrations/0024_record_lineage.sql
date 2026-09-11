-- ============================================================================
-- 0024  Record lineage: which import wrote which record
-- ============================================================================
-- Until now a business record (an order, a product, an expense) did not know
-- which import wrote it. Records are matched by source + external id and each
-- import simply overwrites, so "remove what this file added" had no safe
-- answer. This migration gives every record a written history of the imports,
-- syncs and direct edits that wrote it -- the foundation for withdrawing an
-- import without touching anything another source also owns.
--
-- WHAT IT ADDS
--   1. Withdrawal markers on orders, products, expenses and import_batches.
--      NOTHING SETS THEM YET: the withdraw and restore functions come with the
--      Data Sources screen. The markers are guarded now, so they can never be
--      set by anything else.
--   2. record_lineage: one row per record per import that wrote it.
--   3. Automatic capture. import_load_batch() -- which every import, sync and
--      webhook write already calls first -- tags the transaction with its
--      batch; triggers on the three tables record the write. A write with no
--      tag is a DIRECT edit, which makes the record shared.
--   4. Lineage recovered for imports made before this migration, from the raw
--      rows and column choices each upload kept. Anything that cannot be
--      traced safely is marked UNTRACED, which also makes it shared: the safe
--      direction to fail in.
--
-- NO FIGURE CHANGES. No reader filters on the markers yet, and none is set.
--
-- Depends on 0001-0023. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Withdrawal markers
-- ----------------------------------------------------------------------------

alter table public.orders
  add column withdrawn_at       timestamptz,
  add column withdrawn_by_batch uuid references public.import_batches (id);

alter table public.products
  add column withdrawn_at       timestamptz,
  add column withdrawn_by_batch uuid references public.import_batches (id);

alter table public.expenses
  add column withdrawn_at       timestamptz,
  add column withdrawn_by_batch uuid references public.import_batches (id);

comment on column public.orders.withdrawn_at is
  'Set when the ONLY import that wrote this order was withdrawn. Changed only '
  'by the withdraw and restore functions, or cleared by a later import writing '
  'the record again.';

alter table public.import_batches
  add column lineage_status text not null default 'RECORDED'
    check (lineage_status in ('RECORDED', 'RECOVERED', 'INCOMPLETE', 'NONE')),
  add column withdrawn_at      timestamptz,
  add column withdrawn_by      uuid references public.profiles (id) on delete set null,
  add column withdrawal_reason text;

comment on column public.import_batches.lineage_status is
  'How well BizMind knows what this import wrote. RECORDED: captured as it ran. '
  'RECOVERED: rebuilt from its stored rows. INCOMPLETE: some of what it wrote '
  'cannot be identified. NONE: it kept no rows to rebuild from. Only RECORDED '
  'and RECOVERED imports can ever be withdrawn.';


-- ----------------------------------------------------------------------------
-- 2. record_lineage
-- ----------------------------------------------------------------------------

create table public.record_lineage (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  /** The import, sync or webhook batch that wrote it. NULL for DIRECT and
      UNTRACED. No ON DELETE action: an import with lineage cannot be deleted
      out from under its history (a business deletion still cascades). */
  batch_id    uuid references public.import_batches (id),
  entity      text not null check (entity in ('ORDER', 'PRODUCT', 'EXPENSE')),
  record_id   uuid not null,
  /** The order ID, SKU or Reference, as it stood when written. */
  record_key  text,
  how         text not null
    check (how in ('CREATED', 'UPDATED', 'RECOVERED', 'DIRECT', 'UNTRACED')),
  written_at  timestamptz not null default now(),

  constraint record_lineage_batch_matches_how
    check ((batch_id is null) = (how in ('DIRECT', 'UNTRACED')))
);

comment on table public.record_lineage is
  'Which imports, syncs and direct edits wrote each business record. A record '
  'is withdrawn only when every write to it came from the import being '
  'withdrawn (or from imports already withdrawn).';

create unique index record_lineage_batch_key
  on public.record_lineage (batch_id, entity, record_id)
  where batch_id is not null;

create unique index record_lineage_unbatched_key
  on public.record_lineage (entity, record_id, how)
  where batch_id is null;

create index record_lineage_record_idx
  on public.record_lineage (business_id, entity, record_id);

create index record_lineage_batch_idx
  on public.record_lineage (batch_id)
  where batch_id is not null;

alter table public.record_lineage enable row level security;
alter table public.record_lineage force row level security;

create policy record_lineage_select_member
  on public.record_lineage for select to authenticated
  using (business_id in (select public.current_user_business_ids()));

-- Nobody writes lineage directly. Forged lineage could make another import's
-- record look like this one's -- and withdrawal would then remove it.
revoke all on public.record_lineage from anon, authenticated;
grant select on public.record_lineage to authenticated;
grant select, insert, update, delete on public.record_lineage to service_role;


-- ----------------------------------------------------------------------------
-- 3. Tagging the transaction with the import being applied
-- ----------------------------------------------------------------------------
-- import_apply_orders(), import_apply_products() and import_apply_expenses()
-- all begin by calling this -- for uploads, syncs and webhooks alike -- so the
-- tag is set in exactly one place. It is transaction-local: it lasts until the
-- end of the one statement PostgREST runs, and no path writes business
-- records after applying an import within the same transaction.
--
-- Identical to 0004 except for the one marked line.

create or replace function public.import_load_batch(p_batch_id uuid)
returns public.import_batches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch
  from public.import_batches
  where id = p_batch_id;

  if not found then
    raise exception 'Import batch not found.' using errcode = '42501';
  end if;

  if v_batch.status = 'COMPLETED' then
    raise exception 'This import has already been applied.' using errcode = 'P0001';
  end if;

  -- 0024: every record written from here on is attributed to this batch.
  perform set_config('bizmind.lineage_batch', v_batch.id::text, true);

  return v_batch;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Capture: a trigger on each of the three tables
-- ----------------------------------------------------------------------------

/**
 * Records who wrote a record. AFTER INSERT OR UPDATE, so only writes that
 * actually happened are recorded.
 *
 * TG_ARGV[0] is the entity, TG_ARGV[1] the column holding its key.
 *
 *   tagged     -> CREATED or UPDATED, against the batch
 *   untagged   -> DIRECT: a person or some other path edited it. Recorded once
 *                 per record, and only when business data actually changed --
 *                 a channel or customer link being cleared by a deletion
 *                 elsewhere is not an edit of the record.
 */
create function public.record_lineage_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tag   text := nullif(current_setting('bizmind.lineage_batch', true), '');
  v_batch uuid;
  v_key   text := to_jsonb(new) ->> tg_argv[1];
  v_quiet text[] := array['updated_at', 'channel_id', 'customer_id',
                          'withdrawn_at', 'withdrawn_by_batch'];
begin
  -- The withdraw and restore functions change only the markers. That is not a
  -- write of business data, and must not make a record look shared.
  if coalesce(current_setting('bizmind.lineage_writer', true), '') = 'on' then
    return null;
  end if;

  if v_tag is null then
    if tg_op = 'UPDATE' and (to_jsonb(new) - v_quiet) = (to_jsonb(old) - v_quiet) then
      return null;
    end if;

    insert into public.record_lineage (business_id, batch_id, entity, record_id, record_key, how)
    values (new.business_id, null, tg_argv[0], new.id, v_key, 'DIRECT')
    on conflict (entity, record_id, how) where batch_id is null
    do update set written_at = now(), record_key = excluded.record_key;

    return null;
  end if;

  v_batch := v_tag::uuid;

  -- The tag is only ever set by import_load_batch(), after RLS let the caller
  -- see the batch. Checked again here, because this function bypasses RLS.
  if not exists (
    select 1 from public.import_batches b
    where b.id = v_batch and b.business_id = new.business_id
  ) then
    raise exception 'The import being applied does not belong to this record''s business.'
      using errcode = '42501';
  end if;

  insert into public.record_lineage (business_id, batch_id, entity, record_id, record_key, how)
  values (new.business_id, v_batch, tg_argv[0], new.id, v_key,
          case when tg_op = 'INSERT' then 'CREATED' else 'UPDATED' end)
  on conflict (batch_id, entity, record_id) where batch_id is not null
  do nothing;

  return null;
end;
$$;

create trigger orders_record_lineage
  after insert or update on public.orders
  for each row execute function public.record_lineage_capture('ORDER', 'external_id');

create trigger products_record_lineage
  after insert or update on public.products
  for each row execute function public.record_lineage_capture('PRODUCT', 'sku');

create trigger expenses_record_lineage
  after insert or update on public.expenses
  for each row execute function public.record_lineage_capture('EXPENSE', 'external_id');


-- ----------------------------------------------------------------------------
-- 5. The markers are guarded by the database
-- ----------------------------------------------------------------------------
-- Staff may create and edit orders, products and expenses directly (0002), and
-- may edit any column of an import (0004). Without these guards a staff member
-- could withdraw or revive data by writing a column.

/**
 * On orders, products and expenses. BEFORE INSERT OR UPDATE.
 *
 * An import writing the record brings it back into the business's data: a
 * record written again is, by definition, current. Otherwise only the
 * withdraw/restore functions (which set bizmind.lineage_writer) may change
 * the markers.
 */
create function public.withdrawal_marker_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(current_setting('bizmind.lineage_batch', true), '') is not null then
    new.withdrawn_at := null;
    new.withdrawn_by_batch := null;
    return new;
  end if;

  if coalesce(current_setting('bizmind.lineage_writer', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.withdrawn_at is not null or new.withdrawn_by_batch is not null then
      raise exception 'A record cannot be created already withdrawn.'
        using errcode = '42501';
    end if;
  elsif new.withdrawn_at is distinct from old.withdrawn_at
     or new.withdrawn_by_batch is distinct from old.withdrawn_by_batch then
    raise exception 'Only withdrawing or restoring an import can change this.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger orders_withdrawal_guard
  before insert or update on public.orders
  for each row execute function public.withdrawal_marker_guard();

create trigger products_withdrawal_guard
  before insert or update on public.products
  for each row execute function public.withdrawal_marker_guard();

create trigger expenses_withdrawal_guard
  before insert or update on public.expenses
  for each row execute function public.withdrawal_marker_guard();


/** On import_batches. A new import always starts RECORDED and not withdrawn. */
create function public.import_batch_lineage_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(current_setting('bizmind.lineage_writer', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.lineage_status    := 'RECORDED';
    new.withdrawn_at      := null;
    new.withdrawn_by      := null;
    new.withdrawal_reason := null;
    return new;
  end if;

  if new.lineage_status    is distinct from old.lineage_status
     or new.withdrawn_at      is distinct from old.withdrawn_at
     or new.withdrawal_reason is distinct from old.withdrawal_reason
     -- Clearing who withdrew it is allowed: it is what the database does when
     -- that person's account is deleted (ON DELETE SET NULL), and refusing it
     -- would make their account undeletable. The audit log keeps the name.
     or (new.withdrawn_by is distinct from old.withdrawn_by and new.withdrawn_by is not null) then
    raise exception 'Only withdrawing or restoring an import can change this.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger import_batches_lineage_guard
  before insert or update on public.import_batches
  for each row execute function public.import_batch_lineage_guard();


-- ----------------------------------------------------------------------------
-- 6. Recovering lineage for imports made before this migration
-- ----------------------------------------------------------------------------

/**
 * Rebuilds what one import wrote from the rows and column choices it kept.
 *
 * Exact matching only: the key as the importer read it (trimmed), against the
 * record's key under the same business and source. A key that no longer
 * matches is simply not claimed -- the record is then left UNTRACED below,
 * never attributed on a guess.
 *
 *   RECOVERED   keys rebuilt; what matched is attributed
 *   INCOMPLETE  some rows had no identity at all (an expense with no
 *               Reference is written blind, so it cannot be traced)
 *   NONE        nothing to rebuild from (syncs, webhooks, empty uploads)
 *   RECORDED    it never wrote anything (not completed)
 *
 * Never touches an import whose lineage was recorded as it ran. For imports
 * made before lineage existed; service_role only.
 */
create function public.record_lineage_recover_batch(p_batch_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch   public.import_batches;
  v_column  text;
  v_keyless integer := 0;
  v_status  text;
begin
  select * into v_batch from public.import_batches where id = p_batch_id;
  if v_batch.id is null then
    raise exception 'No such import.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.record_lineage l
    where l.batch_id = v_batch.id and l.how in ('CREATED', 'UPDATED')
  ) then
    return v_batch.lineage_status;
  end if;

  perform set_config('bizmind.lineage_writer', 'on', true);

  if v_batch.status <> 'COMPLETED' then
    v_status := 'RECORDED';
  elsif v_batch.file_type = 'api'
     or v_batch.mapping is null
     or jsonb_typeof(v_batch.raw_rows) is distinct from 'array'
     or jsonb_array_length(v_batch.raw_rows) = 0 then
    v_status := 'NONE';
  else
    v_column := nullif(
      v_batch.mapping ->> (case v_batch.entity when 'PRODUCTS' then 'sku' else 'external_id' end),
      ''
    );

    if v_column is null then
      v_status := 'INCOMPLETE';
    else
      select count(*) into v_keyless
      from jsonb_array_elements(v_batch.raw_rows) as e(item)
      where nullif(trim(e.item ->> v_column), '') is null;

      if v_batch.entity = 'ORDERS' then
        insert into public.record_lineage
          (business_id, batch_id, entity, record_id, record_key, how, written_at)
        select v_batch.business_id, v_batch.id, 'ORDER', o.id, o.external_id, 'RECOVERED',
               coalesce(v_batch.committed_at, v_batch.created_at)
        from (
          select distinct nullif(trim(e.item ->> v_column), '') as k
          from jsonb_array_elements(v_batch.raw_rows) as e(item)
        ) keys
        join public.orders o
          on o.business_id = v_batch.business_id
         and o.source = v_batch.source
         and o.external_id = keys.k
        on conflict (batch_id, entity, record_id) where batch_id is not null do nothing;

        -- A row with no Order ID failed validation and wrote nothing.
        v_status := 'RECOVERED';

      elsif v_batch.entity = 'PRODUCTS' then
        insert into public.record_lineage
          (business_id, batch_id, entity, record_id, record_key, how, written_at)
        select v_batch.business_id, v_batch.id, 'PRODUCT', p.id, p.sku, 'RECOVERED',
               coalesce(v_batch.committed_at, v_batch.created_at)
        from (
          select distinct nullif(trim(e.item ->> v_column), '') as k
          from jsonb_array_elements(v_batch.raw_rows) as e(item)
        ) keys
        join public.products p
          on p.business_id = v_batch.business_id
         and p.sku = keys.k
        on conflict (batch_id, entity, record_id) where batch_id is not null do nothing;

        -- A row with no SKU failed validation and wrote nothing.
        v_status := 'RECOVERED';

      else
        insert into public.record_lineage
          (business_id, batch_id, entity, record_id, record_key, how, written_at)
        select v_batch.business_id, v_batch.id, 'EXPENSE', x.id, x.external_id, 'RECOVERED',
               coalesce(v_batch.committed_at, v_batch.created_at)
        from (
          select distinct nullif(trim(e.item ->> v_column), '') as k
          from jsonb_array_elements(v_batch.raw_rows) as e(item)
        ) keys
        join public.expenses x
          on x.business_id = v_batch.business_id
         and x.source = v_batch.source
         and x.external_id = keys.k
        on conflict (batch_id, entity, record_id) where batch_id is not null do nothing;

        -- An expense with no Reference was written blind: it cannot be told
        -- apart from any other, so this import cannot be traced in full.
        v_status := case when v_keyless > 0 then 'INCOMPLETE' else 'RECOVERED' end;
      end if;
    end if;
  end if;

  update public.import_batches set lineage_status = v_status where id = v_batch.id;

  return v_status;
end;
$$;


do $$
declare
  v_id uuid;
begin
  perform set_config('bizmind.lineage_writer', 'on', true);

  for v_id in select id from public.import_batches order by created_at loop
    perform public.record_lineage_recover_batch(v_id);
  end loop;

  -- Everything that could not be traced is marked UNTRACED, which makes it
  -- shared: no import can ever withdraw it. Two cases:
  --   (a) no recovered import claims it -- a sync, a webhook, a blind expense,
  --       or a key that no longer matches
  --   (b) a source a sync or webhook ALSO wrote to without keeping rows --
  --       its record may have been written by that sync too, and nobody can
  --       now prove otherwise
  insert into public.record_lineage (business_id, batch_id, entity, record_id, record_key, how, written_at)
  select o.business_id, null, 'ORDER', o.id, o.external_id, 'UNTRACED', o.created_at
  from public.orders o
  where not exists (
          select 1 from public.record_lineage l
          where l.entity = 'ORDER' and l.record_id = o.id)
     or exists (
          select 1 from public.import_batches b
          where b.business_id = o.business_id and b.entity = 'ORDERS'
            and b.lineage_status = 'NONE' and b.source is not distinct from o.source)
  on conflict (entity, record_id, how) where batch_id is null do nothing;

  insert into public.record_lineage (business_id, batch_id, entity, record_id, record_key, how, written_at)
  select p.business_id, null, 'PRODUCT', p.id, p.sku, 'UNTRACED', p.created_at
  from public.products p
  where not exists (
          select 1 from public.record_lineage l
          where l.entity = 'PRODUCT' and l.record_id = p.id)
     or exists (
          select 1 from public.import_batches b
          where b.business_id = p.business_id and b.entity = 'PRODUCTS'
            and b.lineage_status = 'NONE')
  on conflict (entity, record_id, how) where batch_id is null do nothing;

  insert into public.record_lineage (business_id, batch_id, entity, record_id, record_key, how, written_at)
  select x.business_id, null, 'EXPENSE', x.id, x.external_id, 'UNTRACED', x.created_at
  from public.expenses x
  where not exists (
          select 1 from public.record_lineage l
          where l.entity = 'EXPENSE' and l.record_id = x.id)
     or exists (
          select 1 from public.import_batches b
          where b.business_id = x.business_id and b.entity = 'EXPENSES'
            and b.lineage_status in ('NONE', 'INCOMPLETE')
            and b.source is not distinct from x.source)
  on conflict (entity, record_id, how) where batch_id is null do nothing;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Function privileges
-- ----------------------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon and authenticated by
-- default. Trigger functions need no caller privilege to fire.

revoke all on function public.record_lineage_capture() from anon, authenticated, public;
revoke all on function public.withdrawal_marker_guard() from anon, authenticated, public;
revoke all on function public.import_batch_lineage_guard() from anon, authenticated, public;
revoke all on function public.record_lineage_recover_batch(uuid) from anon, authenticated, public;
grant execute on function public.record_lineage_recover_batch(uuid) to service_role;


-- ----------------------------------------------------------------------------
-- 8. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_trigger text;
  v_missing bigint;
  v_summary text;
begin
  if not (select c.relrowsecurity and c.relforcerowsecurity
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'record_lineage') then
    raise exception 'SECURITY: RLS is not enabled and forced on record_lineage.';
  end if;

  if has_table_privilege('authenticated', 'public.record_lineage', 'INSERT')
     or has_table_privilege('authenticated', 'public.record_lineage', 'UPDATE')
     or has_table_privilege('authenticated', 'public.record_lineage', 'DELETE') then
    raise exception 'SECURITY: a signed-in user can write lineage.';
  end if;

  if has_table_privilege('anon', 'public.record_lineage', 'SELECT') then
    raise exception 'SECURITY: anon can read lineage.';
  end if;

  foreach v_trigger in array array[
    'orders_record_lineage', 'products_record_lineage', 'expenses_record_lineage',
    'orders_withdrawal_guard', 'products_withdrawal_guard', 'expenses_withdrawal_guard',
    'import_batches_lineage_guard'
  ]
  loop
    if not exists (select 1 from pg_trigger t where t.tgname = v_trigger and not t.tgisinternal) then
      raise exception 'Trigger % is missing.', v_trigger;
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_lineage_recover_batch'
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: record_lineage_recover_batch() is callable without service_role.';
  end if;

  -- THE INVARIANT: every business record has at least one line of history.
  -- A record with none could look exclusively owned by the wrong import.
  select
    (select count(*) from public.orders o
      where not exists (select 1 from public.record_lineage l
                        where l.entity = 'ORDER' and l.record_id = o.id))
  + (select count(*) from public.products p
      where not exists (select 1 from public.record_lineage l
                        where l.entity = 'PRODUCT' and l.record_id = p.id))
  + (select count(*) from public.expenses x
      where not exists (select 1 from public.record_lineage l
                        where l.entity = 'EXPENSE' and l.record_id = x.id))
  into v_missing;

  if v_missing <> 0 then
    raise exception '% existing records have no lineage at all.', v_missing;
  end if;

  select string_agg(format('%s %s', n, s), ', ')
  into v_summary
  from (select lineage_status as s, count(*) as n
        from public.import_batches group by lineage_status order by lineage_status) t;

  raise notice
    'Migration 0024 verified: lineage is captured for every import, sync, '
    'webhook and direct edit; the markers can be changed only by withdrawal; '
    'every existing record has history. Imports by lineage: %.',
    coalesce(v_summary, 'none yet');
end;
$$;


commit;
