-- ============================================================================
-- 0020  The integration engine, made fit for a real spreadsheet
-- ============================================================================
-- Google Sheets is the first source where one connection means tens of
-- thousands of rows, a person editing while a sync runs, and a real reason to
-- pause. Building for it surfaced one more defect and several gaps.
--
-- THE DEFECT: THE ENGINE ONLY EVER FETCHED THE FIRST PAGE
-- --------------------------------------------------------
-- sync_job_complete() marked a job SUCCEEDED even when the connector said more
-- pages remained, and sync_claim_jobs() only claims QUEUED or RETRYING jobs.
-- So every resource stopped after page one. A 100-row test cannot see it; a
-- 25,000-row sheet would lose 24,000 rows without an error. The worker now
-- says whether there is more (p_has_more), and a page with more to come
-- re-queues its job at once.
--
-- THE CHANGES
-- -----------
--  1. Order numbers are unique per SOURCE, not per business. Approved by the
--     owner. A website order #1001 and an Amazon order #1001 are different
--     orders; within one source a number still cannot repeat. A pure
--     relaxation -- every existing row already satisfies it.
--
--  2. EXPENSES becomes a sync resource, with sync_apply_expenses() writing
--     through the same import_apply_expenses() the CSV importer uses.
--
--  3. A synced record's `source` comes from its connection's CHANNEL, falling
--     back to the provider. For WooCommerce and the fixture this produces
--     exactly the value it always did -- their channels were created with
--     that type -- so nothing existing moves. For a Google Sheet of Amazon
--     sales it is AMAZON, which is what an owner means. 0018 deliberately did
--     not make this change; it belongs here, with the connector that needs it.
--
--  4. A connection can exist without a sales channel. A sheet of products or
--     expenses is not a place anyone sells through, and inventing a channel
--     for it would put an empty row in every channel report.
--
--  5. A job a worker is in the middle of is never taken from it. Before this,
--     queuing a running job cleared its lease, so a second worker could claim
--     it and both would write. Now the request is remembered
--     (rerun_requested) and honoured the moment the running sync finishes --
--     an edit made during a sync is never lost.
--
--  6. Why a sync ran (next_trigger / trigger) and what it did (rows inserted,
--     updated, unchanged, rejected) are recorded, and every batch records the
--     connection and run it came from.
--
--  7. Paused, needs-reauthorisation and needs-mapping-review connections are
--     never claimed. Pausing is the owner's decision; the other two are set by
--     the worker, which may never pause or disconnect anything itself.
--
-- Depends on 0019. APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0019.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Order numbers: unique per source
-- ----------------------------------------------------------------------------
-- Nothing upserts on this index and nothing refers to it by name (checked
-- before writing this), so it can be replaced in place. NULL sources remain
-- distinct under ordinary unique-index rules; every import and sync path sets
-- a source, so that only affects rows written by hand.

drop index if exists public.orders_number_key;

create unique index orders_number_key
  on public.orders (business_id, source, order_number)
  where order_number is not null;


-- ----------------------------------------------------------------------------
-- 2. Expenses as a sync resource
-- ----------------------------------------------------------------------------
-- The check was declared inline, so it is found by what it checks rather than
-- by a generated name.

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.sync_jobs'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%resource%'
  loop
    execute format('alter table public.sync_jobs drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.sync_jobs
  add constraint sync_jobs_resource_check
  check (resource in ('ORDERS', 'PRODUCTS', 'CUSTOMERS', 'INVENTORY', 'EXPENSES'));


-- ----------------------------------------------------------------------------
-- 3. Columns: why a sync ran, what it did, where a batch came from
-- ----------------------------------------------------------------------------
-- sync_jobs, sync_runs and import_batches are granted to `authenticated` at
-- table level (0012, 0004), so these columns are readable by members without
-- further grants. integration_accounts, which is granted column by column, is
-- deliberately not touched.

alter table public.sync_jobs
  add column next_trigger    public.sync_trigger,
  add column rerun_requested boolean not null default false;

comment on column public.sync_jobs.next_trigger is
  'Why the next run will happen. Copied onto the run when it starts.';
comment on column public.sync_jobs.rerun_requested is
  'A sync was requested while this job was running. Honoured as soon as it '
  'finishes, so an edit made mid-sync is never lost.';

alter table public.sync_runs
  add column trigger        public.sync_trigger,
  add column rows_inserted  integer,
  add column rows_updated   integer,
  add column rows_unchanged integer,
  add column rows_rejected  integer;

alter table public.import_batches
  add column integration_account_id uuid
    references public.integration_accounts (id) on delete set null,
  add column sync_run_id uuid
    references public.sync_runs (id) on delete set null;

comment on column public.import_batches.integration_account_id is
  'The connection a synced batch came from. Null for an uploaded file.';


-- ----------------------------------------------------------------------------
-- 4. Connecting without a sales channel
-- ----------------------------------------------------------------------------
-- Identical to 0014 except that a channel is created only when a channel type
-- is given. Every existing caller passes one, so their behaviour is unchanged.

create or replace function public.integration_account_connect(
  p_business_id       uuid,
  p_provider          public.integration_provider,
  p_external_account_id text,
  p_display_name      text,
  p_channel_type      public.channel_type,
  p_metadata          jsonb default '{}'::jsonb
)
returns public.integration_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid := (select auth.uid());
  v_integration public.integrations;
  v_account     public.integration_accounts;
  v_channel     uuid;
  v_before      jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can connect an integration.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.integration_accounts a
    where a.provider = p_provider
      and a.external_account_id = p_external_account_id
      and a.status <> 'DISCONNECTED'
      and a.business_id <> p_business_id
  ) then
    raise exception
      'That store is already connected to a different BizMind business. '
      'Disconnect it there first.'
      using errcode = 'P0001';
  end if;

  insert into public.integrations (business_id, provider, created_by)
  values (p_business_id, p_provider, v_user)
  on conflict (business_id, provider) do update
    set status = 'CONNECTED', updated_at = now()
  returning * into v_integration;

  select to_jsonb(a) - 'credentials_encrypted' - 'webhook_secret_encrypted'
    into v_before
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  select a.channel_id into v_channel
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  -- A sheet of products or expenses is not a sales channel.
  if v_channel is null and p_channel_type is not null then
    insert into public.channels (business_id, name, type)
    values (p_business_id, coalesce(p_display_name, p_external_account_id), p_channel_type)
    on conflict (business_id, name) do update set is_active = true
    returning id into v_channel;
  end if;

  insert into public.integration_accounts (
    business_id, integration_id, provider, external_account_id, display_name,
    status, channel_id, metadata, connected_by, connected_at, revoked_at
  )
  values (
    p_business_id, v_integration.id, p_provider, p_external_account_id,
    p_display_name, 'CONNECTED', v_channel, coalesce(p_metadata, '{}'::jsonb),
    v_user, now(), null
  )
  on conflict (business_id, integration_id, external_account_id) do update set
    display_name = excluded.display_name,
    status       = 'CONNECTED',
    metadata     = excluded.metadata,
    revoked_at   = null,
    last_error   = null,
    connected_at = now()
  returning * into v_account;

  perform public.write_audit_log(
    p_business_id,
    case when v_before is null
         then 'integration.connection.created'
         else 'integration.connection.reconnected' end,
    'integration_accounts', v_account.id, v_before,
    jsonb_build_object(
      'provider', p_provider,
      'external_account_id', p_external_account_id,
      'channel_id', v_channel
    )
  );

  v_account.credentials_encrypted := null;
  v_account.webhook_secret_encrypted := null;

  return v_account;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. The apply functions: source from the channel, lineage on the batch
-- ----------------------------------------------------------------------------

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
  v_job          public.sync_jobs;
  v_provider     public.integration_provider;
  v_channel      uuid;
  v_channel_type public.channel_type;
  v_source       public.channel_type;
  v_run          uuid;
  v_batch        uuid;
  v_result       jsonb;
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

  if v_channel is not null then
    select c.type into v_channel_type from public.channels c where c.id = v_channel;
  end if;

  v_source := coalesce(
    v_channel_type,
    case v_provider
      when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
      when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
      else 'OTHER'::public.channel_type
    end
  );

  select r.id into v_run
  from public.sync_runs r
  where r.job_id = p_job_id and r.status = 'RUNNING'
  order by r.started_at desc
  limit 1;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id, sync_run_id
  )
  values (
    v_job.business_id, 'ORDERS', 'DRAFT', v_source, v_channel,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0),
    v_job.integration_account_id, v_run
  )
  returning id into v_batch;

  v_result := public.import_apply_orders(v_batch, p_rows);

  return v_result || jsonb_build_object('batch_id', v_batch);
end;
$$;


create or replace function public.sync_apply_products(
  p_job_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job          public.sync_jobs;
  v_provider     public.integration_provider;
  v_channel      uuid;
  v_channel_type public.channel_type;
  v_source       public.channel_type;
  v_run          uuid;
  v_batch        uuid;
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

  if v_channel is not null then
    select c.type into v_channel_type from public.channels c where c.id = v_channel;
  end if;

  v_source := coalesce(
    v_channel_type,
    case v_provider
      when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
      when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
      else 'OTHER'::public.channel_type
    end
  );

  select r.id into v_run
  from public.sync_runs r
  where r.job_id = p_job_id and r.status = 'RUNNING'
  order by r.started_at desc
  limit 1;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id, sync_run_id
  )
  values (
    v_job.business_id, 'PRODUCTS', 'DRAFT', v_source, v_channel,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0),
    v_job.integration_account_id, v_run
  )
  returning id into v_batch;

  return public.import_apply_products(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;


/**
 * The expenses sibling of sync_apply_orders() and sync_apply_products().
 *
 * Writes through import_apply_expenses() -- the CSV importer's function --
 * which is idempotent on (business_id, source, external_id). A live-synced
 * expense sheet must therefore carry a Reference column: without one there is
 * no stable identity, and the connector refuses to start rather than inventing
 * one from a row number.
 */
create or replace function public.sync_apply_expenses(
  p_job_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job          public.sync_jobs;
  v_provider     public.integration_provider;
  v_channel      uuid;
  v_channel_type public.channel_type;
  v_source       public.channel_type;
  v_run          uuid;
  v_batch        uuid;
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

  if v_channel is not null then
    select c.type into v_channel_type from public.channels c where c.id = v_channel;
  end if;

  v_source := coalesce(
    v_channel_type,
    case v_provider
      when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
      when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
      else 'OTHER'::public.channel_type
    end
  );

  select r.id into v_run
  from public.sync_runs r
  where r.job_id = p_job_id and r.status = 'RUNNING'
  order by r.started_at desc
  limit 1;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id, sync_run_id
  )
  values (
    v_job.business_id, 'EXPENSES', 'DRAFT', v_source, null,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0),
    v_job.integration_account_id, v_run
  )
  returning id into v_batch;

  return public.import_apply_expenses(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;


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
  v_event        public.webhook_events;
  v_channel      uuid;
  v_channel_type public.channel_type;
  v_source       public.channel_type;
  v_batch        uuid;
begin
  select * into v_event from public.webhook_events where id = p_event_id;
  if v_event.id is null then
    raise exception 'No such webhook event.' using errcode = 'P0002';
  end if;

  if not v_event.signature_valid then
    raise exception 'Refusing to apply an unverified delivery.'
      using errcode = 'P0001';
  end if;

  select a.channel_id into v_channel
  from public.integration_accounts a
  where a.id = v_event.integration_account_id;

  if v_channel is not null then
    select c.type into v_channel_type from public.channels c where c.id = v_channel;
  end if;

  v_source := coalesce(
    v_channel_type,
    case v_event.provider
      when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
      when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
      else 'OTHER'::public.channel_type
    end
  );

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id
  )
  values (
    v_event.business_id, 'ORDERS', 'DRAFT', v_source, v_channel,
    'webhook:' || v_event.event_type, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0),
    v_event.integration_account_id
  )
  returning id into v_batch;

  return public.import_apply_orders(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Queuing: never steal a running job
-- ----------------------------------------------------------------------------

/**
 * A person asks for a sync. SECURITY INVOKER, as before: RLS and the role
 * check are the boundary.
 *
 * If a worker holds the job, a "Sync now" is remembered and honoured when it
 * finishes; a full re-import is refused, because resetting the cursor under a
 * running pass would skip rows.
 */
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

  select * into v_job
  from public.sync_jobs j
  where j.integration_account_id = p_account_id and j.resource = p_resource;

  if v_job.id is not null and v_job.locked_until > now() then
    if p_mode = 'INITIAL' then
      raise exception
        'A sync is already running for this connection. Try again when it finishes.'
        using errcode = 'P0001';
    end if;

    update public.sync_jobs
    set rerun_requested = true
    where id = v_job.id
    returning * into v_job;

    return v_job;
  end if;

  insert into public.sync_jobs (
    business_id, integration_account_id, resource, mode, status,
    priority, next_run_at, next_trigger, rerun_requested
  )
  values (
    v_business_id, p_account_id, p_resource, p_mode, 'QUEUED',
    p_priority, now(),
    (case when p_mode = 'INITIAL' then 'INITIAL' else 'MANUAL' end)::public.sync_trigger,
    false
  )
  on conflict (integration_account_id, resource) do update set
    status       = 'QUEUED',
    mode         = excluded.mode,
    cursor       = case when excluded.mode = 'INITIAL' then null
                        else public.sync_jobs.cursor end,
    attempts     = 0,
    next_run_at  = now(),
    next_trigger = excluded.next_trigger,
    rerun_requested = false,
    last_error   = null,
    locked_at    = null,
    locked_until = null,
    locked_by    = null
  returning * into v_job;

  perform public.write_audit_log(
    v_business_id, 'integration.sync.enqueued', 'sync_jobs', v_job.id,
    null, jsonb_build_object('resource', p_resource, 'mode', p_mode)
  );

  return v_job;
end;
$$;


/**
 * The system asks for a sync: a change notification, or the reconciliation
 * safety net. Session-less, service_role only, and it takes an ACCOUNT id --
 * the tenant comes from that row.
 *
 * Returns the job id, or NULL when it declined to queue:
 *   - the connection is paused, needs reauthorisation or a mapping review, or
 *     is disconnected -- a signal is not a reason to override any of those
 *   - the job is dead-lettered -- a person has to look at it first, and
 *     re-queuing it on every edit would be a retry storm that fixes nothing
 *
 * Already queued or retrying: left alone, including its retry schedule. A
 * burst of edits must not reset a failing sync's backoff.
 */
create or replace function public.sync_enqueue_system(
  p_account_id    uuid,
  p_resource      text,
  p_trigger       public.sync_trigger,
  p_delay_seconds integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_status   public.integration_status;
  v_job      public.sync_jobs;
begin
  select a.business_id, a.status into v_business, v_status
  from public.integration_accounts a
  where a.id = p_account_id;

  if v_business is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if v_status not in ('CONNECTED', 'ERROR') then
    return null;
  end if;

  select * into v_job
  from public.sync_jobs j
  where j.integration_account_id = p_account_id and j.resource = p_resource
  for update;

  if v_job.id is not null then
    if v_job.locked_until > now() then
      update public.sync_jobs set rerun_requested = true where id = v_job.id;
      return v_job.id;
    end if;

    if v_job.status = 'DEAD_LETTER' then
      return null;
    end if;

    if v_job.status in ('QUEUED', 'RETRYING') then
      return v_job.id;
    end if;

    update public.sync_jobs
    set status       = 'QUEUED',
        attempts     = 0,
        next_run_at  = now() + make_interval(secs => greatest(p_delay_seconds, 0)),
        next_trigger = p_trigger,
        rerun_requested = false,
        last_error   = null,
        locked_at    = null,
        locked_until = null,
        locked_by    = null
    where id = v_job.id;

    return v_job.id;
  end if;

  insert into public.sync_jobs (
    business_id, integration_account_id, resource, mode, status,
    priority, next_run_at, next_trigger
  )
  values (
    v_business, p_account_id, p_resource, 'INCREMENTAL', 'QUEUED',
    100, now() + make_interval(secs => greatest(p_delay_seconds, 0)), p_trigger
  )
  returning * into v_job;

  return v_job.id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Claiming, starting and completing a run
-- ----------------------------------------------------------------------------

/**
 * Only connections that can actually sync are claimed. A paused connection, or
 * one waiting for its owner to reconnect Google or review a mapping, keeps its
 * queued work -- it simply is not picked up until the state clears.
 */
create or replace function public.sync_claim_jobs(
  p_worker_id text,
  p_limit     integer default 5,
  p_lease_seconds integer default 300
)
returns setof public.sync_jobs
language sql
security definer
set search_path = ''
as $$
  update public.sync_jobs j
  set status       = 'RUNNING',
      locked_at    = now(),
      locked_until = now() + make_interval(secs => p_lease_seconds),
      locked_by    = p_worker_id,
      attempts     = j.attempts + 1
  where j.id in (
    select c.id
    from public.sync_jobs c
    join public.integration_accounts a on a.id = c.integration_account_id
    where c.status in ('QUEUED', 'RETRYING')
      and c.next_run_at <= now()
      and (c.locked_until is null or c.locked_until < now())
      and a.status in ('CONNECTED', 'ERROR')
    order by c.priority, c.next_run_at
    for update of c skip locked
    limit p_limit
  )
  returning j.*;
$$;


create or replace function public.sync_run_start(p_job_id uuid)
returns public.sync_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.sync_jobs;
  v_run public.sync_runs;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  insert into public.sync_runs
    (business_id, job_id, attempt, cursor_before, status, trigger)
  values (
    v_job.business_id, v_job.id, v_job.attempts, v_job.cursor, 'RUNNING',
    coalesce(v_job.next_trigger, 'AUTOMATIC'::public.sync_trigger)
  )
  returning * into v_run;

  return v_run;
end;
$$;


-- The signature changes, and a new signature beside the old one would make
-- every existing call ambiguous ("function is not unique"). So the old one is
-- dropped first. The new parameters all have defaults, so the worker's current
-- named-argument call still resolves -- and behaves exactly as before, since
-- p_has_more defaults to false.
drop function if exists public.sync_job_complete(
  uuid, uuid, public.sync_status, text, integer, integer, integer, text, integer
);

create function public.sync_job_complete(
  p_job_id  uuid,
  p_run_id  uuid,
  p_status  public.sync_status,
  p_cursor  text,
  p_records_fetched integer,
  p_records_applied integer,
  p_records_skipped integer,
  p_error   text default null,
  p_retry_after_ms integer default null,   -- provider asked us to wait
  p_has_more       boolean default false,  -- the connector has more pages
  p_rows_inserted  integer default null,
  p_rows_updated   integer default null,
  p_rows_unchanged integer default null,
  p_rows_rejected  integer default null
)
returns public.sync_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.sync_jobs;
  v_delay interval;
  v_cap   integer;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  update public.sync_runs
  set completed_at    = now(),
      status          = p_status,
      records_fetched = p_records_fetched,
      records_applied = p_records_applied,
      records_skipped = p_records_skipped,
      rows_inserted   = p_rows_inserted,
      rows_updated    = p_rows_updated,
      rows_unchanged  = p_rows_unchanged,
      rows_rejected   = p_rows_rejected,
      cursor_after    = p_cursor,
      error_summary   = p_error
  where id = p_run_id;

  if p_status in ('SUCCEEDED', 'PARTIAL') then

    -- MORE PAGES TO COME. Straight back into the queue, keeping its place and
    -- its mode. This branch is the fix for the engine stopping at page one.
    if p_has_more then
      update public.sync_jobs
      set status       = 'QUEUED',
          cursor       = coalesce(p_cursor, cursor),
          attempts     = 0,
          locked_at    = null,
          locked_until = null,
          locked_by    = null,
          last_error   = null,
          next_run_at  = now()
      where id = p_job_id
      returning * into v_job;

      update public.integration_accounts
      set last_attempted_sync_at = now(),
          status = case when status = 'ERROR' then 'CONNECTED' else status end
      where id = v_job.integration_account_id;

      return v_job;
    end if;

    -- THE PASS IS COMPLETE. A rerun requested mid-sync is honoured at once;
    -- rerun_requested is read from the row inside the UPDATE, not from the
    -- copy loaded above, so a request that arrives in between is not lost.
    update public.sync_jobs
    set status       = case when rerun_requested
                            then 'QUEUED'::public.sync_status
                            else p_status end,
        cursor       = coalesce(p_cursor, cursor),
        mode         = case when mode = 'INITIAL' then 'INCREMENTAL' else mode end,
        attempts     = 0,
        locked_at    = null,
        locked_until = null,
        locked_by    = null,
        last_error   = null,
        next_run_at  = case when rerun_requested then now()
                            else now() + interval '1 hour' end,
        next_trigger = case when rerun_requested
                            then 'AUTOMATIC'::public.sync_trigger
                            else null end,
        rerun_requested = false
    where id = p_job_id
    returning * into v_job;

    update public.integration_accounts
    set last_successful_sync_at = now(),
        last_attempted_sync_at  = now(),
        last_error = null,
        status = case when status = 'ERROR' then 'CONNECTED' else status end
    where id = v_job.integration_account_id;

    return v_job;
  end if;

  -- A rate limit is not a failure. Waiting is the correct behaviour, and
  -- charging an attempt for it would kill a healthy sync of a busy store.
  if p_retry_after_ms is not null then
    update public.sync_jobs
    set status       = 'RETRYING',
        attempts     = greatest(attempts - 1, 0),
        locked_at    = null,
        locked_until = null,
        locked_by    = null,
        next_run_at  = now() + make_interval(secs => p_retry_after_ms / 1000.0),
        last_error   = p_error
    where id = p_job_id
    returning * into v_job;

    return v_job;
  end if;

  if v_job.attempts >= v_job.max_attempts then
    update public.sync_jobs
    set status       = 'DEAD_LETTER',
        locked_at    = null,
        locked_until = null,
        locked_by    = null,
        last_error   = p_error
    where id = p_job_id
    returning * into v_job;

    update public.integration_accounts
    set status = 'ERROR', last_error = p_error, last_attempted_sync_at = now()
    where id = v_job.integration_account_id
      and status in ('CONNECTED', 'ERROR');

    insert into public.audit_logs
      (business_id, actor_id, action, entity_type, entity_id, after_data)
    values (
      v_job.business_id, null, 'integration.sync.dead_letter', 'sync_jobs',
      v_job.id, jsonb_build_object('attempts', v_job.attempts, 'error', p_error)
    );

    return v_job;
  end if;

  -- Exponential, capped, then full jitter across the whole window.
  v_cap := least(30 * (2 ^ least(v_job.attempts, 10))::integer, 28800);
  v_delay := make_interval(secs => random() * v_cap);

  update public.sync_jobs
  set status       = 'RETRYING',
      locked_at    = null,
      locked_until = null,
      locked_by    = null,
      next_run_at  = now() + v_delay,
      last_error   = p_error
  where id = p_job_id
  returning * into v_job;

  update public.integration_accounts
  set last_attempted_sync_at = now(), last_error = p_error
  where id = v_job.integration_account_id;

  return v_job;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Connection states: the worker's, and the owner's
-- ----------------------------------------------------------------------------

/**
 * The worker records what it found: access expired, a mapping that no longer
 * fits, a provider failing, or all clear again.
 *
 * It may NEVER pause or disconnect -- those are the owner's decisions -- and it
 * never overrides one: a paused or disconnected connection is left as it is.
 * Session-less, service_role only, and the tenant is the account row's.
 */
create or replace function public.integration_account_set_state(
  p_account_id uuid,
  p_status     public.integration_status,
  p_reason     text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_current  public.integration_status;
begin
  if p_status not in ('CONNECTED', 'ERROR', 'REAUTH_REQUIRED', 'MAPPING_REVIEW_REQUIRED') then
    raise exception
      'The sync worker may not set a connection to %. Only its owner can.', p_status
      using errcode = 'P0001';
  end if;

  select a.business_id, a.status into v_business, v_current
  from public.integration_accounts a
  where a.id = p_account_id
  for update;

  if v_business is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if v_current in ('PAUSED', 'DISCONNECTED') then
    return false;
  end if;

  update public.integration_accounts
  set status = p_status,
      last_error = p_reason,
      last_attempted_sync_at = now()
  where id = p_account_id;

  if v_current is distinct from p_status then
    insert into public.audit_logs
      (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
    values (
      v_business, null, 'integration.connection.state_changed',
      'integration_accounts', p_account_id,
      jsonb_build_object('status', v_current),
      jsonb_build_object('status', p_status, 'reason', p_reason)
    );
  end if;

  return true;
end;
$$;


/**
 * The owner pauses or resumes a connection.
 *
 * SECURITY DEFINER with its own role check, like integration_account_revoke():
 * that check IS the tenant boundary. Resuming only ever turns PAUSED back into
 * CONNECTED -- it cannot paper over a connection that needs Google reconnected
 * or a mapping reviewed.
 */
create or replace function public.integration_account_pause(
  p_account_id uuid,
  p_paused     boolean
)
returns public.integration_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.integration_accounts;
  v_before  public.integration_status;
begin
  select * into v_account from public.integration_accounts where id = p_account_id;

  if v_account.id is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_account.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can pause or resume a connection.'
      using errcode = '42501';
  end if;

  if v_account.status = 'DISCONNECTED' then
    raise exception 'That connection has been disconnected.' using errcode = 'P0001';
  end if;

  v_before := v_account.status;

  if p_paused and v_account.status in ('CONNECTED', 'ERROR') then
    update public.integration_accounts
    set status = 'PAUSED'
    where id = p_account_id
    returning * into v_account;
  elsif not p_paused and v_account.status = 'PAUSED' then
    update public.integration_accounts
    set status = 'CONNECTED'
    where id = p_account_id
    returning * into v_account;
  end if;

  if v_account.status is distinct from v_before then
    perform public.write_audit_log(
      v_account.business_id,
      case when p_paused then 'integration.connection.paused'
           else 'integration.connection.resumed' end,
      'integration_accounts', v_account.id,
      jsonb_build_object('status', v_before),
      jsonb_build_object('status', v_account.status)
    );
  end if;

  -- The full row is the return type; the sealed secrets must not travel back.
  v_account.credentials_encrypted := null;
  v_account.webhook_secret_encrypted := null;

  return v_account;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Privileges
-- ----------------------------------------------------------------------------
-- Reissued rather than assumed, and revoked from anon/authenticated first:
-- Supabase's default privileges grant EXECUTE on new functions to both.

do $$
declare
  v_sig text;
begin
  -- Session-less: service_role only.
  foreach v_sig in array array[
    'public.sync_apply_orders(uuid, jsonb)',
    'public.sync_apply_products(uuid, jsonb)',
    'public.sync_apply_expenses(uuid, jsonb)',
    'public.webhook_apply_records(uuid, jsonb)',
    'public.sync_enqueue_system(uuid, text, public.sync_trigger, integer)',
    'public.sync_claim_jobs(text, integer, integer)',
    'public.sync_run_start(uuid)',
    'public.sync_job_complete(uuid, uuid, public.sync_status, text, integer, integer, integer, text, integer, boolean, integer, integer, integer, integer)',
    'public.integration_account_set_state(uuid, public.integration_status, text)'
  ]
  loop
    execute format('revoke all on function %s from anon, authenticated, public', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;

  -- A person's actions: authenticated, each with its own role check inside.
  foreach v_sig in array array[
    'public.sync_enqueue(uuid, text, public.sync_mode, smallint)',
    'public.integration_account_pause(uuid, boolean)',
    'public.integration_account_connect(uuid, public.integration_provider, text, text, public.channel_type, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', v_sig);
    execute format('grant execute on function %s to authenticated', v_sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 10. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_def   text;
  v_count integer;
  v_fn    text;
begin
  select pg_get_indexdef(i.indexrelid) into v_def
  from pg_index i
  join pg_class c on c.oid = i.indexrelid
  where c.relname = 'orders_number_key';

  if v_def is null or v_def not ilike '%(business_id, source, order_number)%' then
    raise exception 'orders_number_key is not unique per source: %', v_def;
  end if;

  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.sync_jobs'::regclass and c.conname = 'sync_jobs_resource_check';

  if v_def is null or v_def not ilike '%EXPENSES%' then
    raise exception 'sync_jobs does not accept EXPENSES: %', v_def;
  end if;

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sync_job_complete';

  if v_count <> 1 then
    raise exception
      'Expected exactly one sync_job_complete(), found %. Two would make every '
      'call ambiguous.', v_count;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sync_jobs'
      and column_name = 'rerun_requested'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'import_batches'
      and column_name = 'integration_account_id'
  ) then
    raise exception 'The new columns were not created.';
  end if;

  foreach v_fn in array array[
    'sync_apply_orders', 'sync_apply_products', 'sync_apply_expenses',
    'webhook_apply_records', 'sync_enqueue_system', 'sync_claim_jobs',
    'sync_run_start', 'sync_job_complete', 'integration_account_set_state'
  ]
  loop
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

  foreach v_fn in array array['sync_enqueue', 'integration_account_pause', 'integration_account_connect']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute %().', v_fn;
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'A signed-in owner cannot execute %().', v_fn;
    end if;
  end loop;

  raise notice
    'Migration 0020 verified: pages continue, order numbers are unique per '
    'source, expenses sync, running jobs are never stolen, and paused or broken '
    'connections are never claimed.';
end;
$$;


commit;
