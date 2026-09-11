-- ============================================================================
-- 0018  The sync write path never wrote a row
-- ============================================================================
-- Found while auditing the engine before building Google Sheets on top of it.
--
-- FAULT 1 -- EVERY SYNC WRITE FAILED IN THE DATABASE
-- --------------------------------------------------
-- sync_apply_orders(), sync_apply_products() and webhook_apply_records() all
-- create an import_batches row with file_type = 'api'. That column's check
-- constraint, from migration 0004, only ever allowed 'csv' and 'xlsx'. So the
-- first insert of every sync write raised a check violation and the whole
-- call rolled back. No synced or webhook-delivered record has ever been
-- written.
--
-- It went unnoticed because no test ever called these functions with rows.
-- The live suite proved that a signed-in user cannot call them -- true, and
-- important -- but a function nobody can misuse is not the same thing as a
-- function that works. `scripts/verify-integration-live.mts` section 6b now
-- calls all three with real rows.
--
-- FAULT 2 -- A SYNCED ORDER WOULD HAVE HAD NO CHANNEL
-- --------------------------------------------------
-- import_apply_orders() takes an order's channel from its batch. The two
-- orders paths never set the batch's channel, so even with fault 1 fixed every
-- synced order would have landed attributed to no channel -- counted in the
-- dashboard's "orders without a channel" and missing from every channel's
-- profitability.
--
-- The channel already exists: integration_account_connect() creates one for
-- each connection and links it. This migration just reads it.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
-- ---------------------------------
-- `source` is still derived from the provider, exactly as before. Orders are
-- unique on (business_id, source, external_id), so changing how `source` is
-- chosen is not a defect fix -- it is a design change, and it belongs with the
-- work that needs it (Google Sheets), argued on its own terms.
--
-- sync_apply_products() is not redefined. Products take neither a channel nor
-- a source from the batch, so fault 1's constraint fix is all it needs.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Allow 'api' as a batch file type
-- ----------------------------------------------------------------------------
-- The original constraint was declared inline, so its name was generated. It
-- is found by what it checks rather than by a guessed name: dropping the wrong
-- constraint by name would fail loudly at best, and silently leave the real
-- one in place at worst.

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.import_batches'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%file_type%'
  loop
    execute format('alter table public.import_batches drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.import_batches
  add constraint import_batches_file_type_check
  check (file_type in ('csv', 'xlsx', 'api'));

comment on column public.import_batches.file_type is
  'csv or xlsx for an uploaded file; api for a batch created by the sync '
  'engine or a webhook delivery.';


-- ----------------------------------------------------------------------------
-- 2. Synced orders take the connection's channel
-- ----------------------------------------------------------------------------
-- Identical to 0012 apart from reading `channel_id` alongside `provider`, and
-- writing it onto the batch. Two scalars in one INTO list is fine; it is a
-- record variable beside a scalar that PL/pgSQL refuses (42601).

create or replace function public.sync_apply_orders(
  p_job_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.sync_jobs;
  v_provider public.integration_provider;
  v_channel  uuid;
  v_source   public.channel_type;
  v_batch    uuid;
  v_result   jsonb;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  select a.provider, a.channel_id into v_provider, v_channel
  from public.integration_accounts a
  where a.id = v_job.integration_account_id;

  if v_provider is null then
    raise exception 'That sync job has no connected account.' using errcode = 'P0002';
  end if;

  v_source := case v_provider
                when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
                when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
                else 'OTHER'::public.channel_type
              end;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count
  )
  values (
    v_job.business_id, 'ORDERS', 'DRAFT', v_source, v_channel,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0)
  )
  returning id into v_batch;

  v_result := public.import_apply_orders(v_batch, p_rows);

  return v_result || jsonb_build_object('batch_id', v_batch);
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. Webhook-delivered orders take the connection's channel too
-- ----------------------------------------------------------------------------
-- The event already records which connection it belongs to -- the tenant was
-- resolved from that row on receipt -- so the channel comes from the same
-- place, never from the delivery.

create or replace function public.webhook_apply_records(
  p_event_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event   public.webhook_events;
  v_channel uuid;
  v_source  public.channel_type;
  v_batch   uuid;
begin
  select * into v_event from public.webhook_events where id = p_event_id;
  if v_event.id is null then
    raise exception 'No such webhook event.' using errcode = 'P0002';
  end if;

  -- Belt and braces. The claim function already filters on this, but an
  -- unverified delivery must never reach a business table by any route.
  if not v_event.signature_valid then
    raise exception 'Refusing to apply an unverified delivery.'
      using errcode = 'P0001';
  end if;

  select a.channel_id into v_channel
  from public.integration_accounts a
  where a.id = v_event.integration_account_id;

  v_source := case v_event.provider
                when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
                when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
                else 'OTHER'::public.channel_type
              end;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count
  )
  values (
    v_event.business_id, 'ORDERS', 'DRAFT', v_source, v_channel,
    'webhook:' || v_event.event_type, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0)
  )
  returning id into v_batch;

  return public.import_apply_orders(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Privileges
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE keeps existing grants, but they are reissued rather than
-- assumed. Both functions are session-less and take ids that resolve their own
-- tenant; a signed-in user reaching either could write into any business.

revoke all on function public.sync_apply_orders(uuid, jsonb)
  from anon, authenticated, public;
grant execute on function public.sync_apply_orders(uuid, jsonb) to service_role;

revoke all on function public.webhook_apply_records(uuid, jsonb)
  from anon, authenticated, public;
grant execute on function public.webhook_apply_records(uuid, jsonb) to service_role;


-- ----------------------------------------------------------------------------
-- 5. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_defs    text[];
  v_fn      text;
begin
  select array_agg(pg_get_constraintdef(c.oid)) into v_defs
  from pg_constraint c
  where c.conrelid = 'public.import_batches'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%file_type%';

  if coalesce(array_length(v_defs, 1), 0) <> 1 then
    raise exception
      'Expected exactly one file_type check on import_batches, found %',
      coalesce(array_length(v_defs, 1), 0);
  end if;

  if v_defs[1] not ilike '%''api''%' then
    raise exception
      'The file_type check still does not allow ''api'': %', v_defs[1];
  end if;

  -- The old values must still be accepted, or every CSV import breaks.
  if v_defs[1] not ilike '%''csv''%' or v_defs[1] not ilike '%''xlsx''%' then
    raise exception
      'The file_type check no longer allows csv and xlsx: %', v_defs[1];
  end if;

  foreach v_fn in array array['sync_apply_orders', 'webhook_apply_records']
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and p.prosrc ilike '%v_channel%'
    ) then
      raise exception '% was not replaced: it does not set the channel.', v_fn;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() is callable without service_role.', v_fn;
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) then
      raise exception 'service_role cannot execute %().', v_fn;
    end if;
  end loop;

  raise notice
    'Migration 0018 verified: sync and webhook batches may be written, '
    'synced orders carry their connection''s channel, and only service_role '
    'can reach either function.';
end;
$$;


commit;
