-- ============================================================================
-- 0021  Google Sheets: watch channels and incremental record state
-- ============================================================================
-- Two tables the existing engine genuinely does not have, and the trusted
-- functions that reach them. Everything else Google Sheets needs is the engine
-- that already exists: connections, jobs, retries, dead letters, the import
-- pipeline.
--
-- 1. integration_watch_channels
-- -----------------------------
-- Google tells BizMind a spreadsheet changed by calling a URL we registered --
-- a "watch channel". Unlike a WooCommerce webhook it EXPIRES: Google's own
-- documentation caps a files.watch channel at 86,400 seconds, one day. So
-- channels must be renewed, and a notification must be matched to a connection
-- by the channel's id rather than by the store identity WooCommerce sends.
--
-- The notification carries NO data and NO signature -- Google's docs: the body
-- is always empty. Authenticity is a secret token we set when creating the
-- channel and Google echoes back in X-Goog-Channel-Token. That token is stored
-- encrypted, bound to the business, and compared in constant time.
--
-- 2. integration_record_state
-- ---------------------------
-- Google Sheets cannot say which rows changed; every sync has to re-read the
-- tab. What CAN be incremental is the writing. Each business record (an order,
-- a product, an expense) keeps a fingerprint of the source content it was built
-- from. A re-read record whose fingerprint has not moved is counted and skipped
-- rather than rewritten.
--
-- It is also the lineage: record -> connection -> spreadsheet and tab, with the
-- row it was last seen at. The row number is a LOCATOR for a person reading the
-- history, never an identity -- rows move when someone sorts or inserts. The
-- identity is the business key the owner confirmed: Order ID, SKU, Reference.
--
-- The fingerprint is written only AFTER the record is applied. Written first, a
-- crash between the two would leave the record marked "unchanged" and the edit
-- would never reach the database.
--
-- WHAT IS NEVER DONE HERE
-- -----------------------
-- Nothing is deleted. A record missing from the sheet is marked not present and
-- REPORTED -- a row that disappeared is not proof the sale never happened, and
-- erasing history on the strength of a spreadsheet edit is not a decision to
-- make automatically. Same rule as WooCommerce deletions.
--
-- Depends on 0019 (enum values) and 0020 (sync_enqueue_system). Apply in order.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0020.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Watch channels
-- ----------------------------------------------------------------------------

create table public.integration_watch_channels (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  integration_account_id uuid not null references public.integration_accounts (id) on delete cascade,

  /** Our id for the channel, sent to Google and echoed in X-Goog-Channel-ID. */
  channel_id  text not null unique,

  /** Google's opaque id for the watched file. channels.stop needs it. */
  resource_id text,

  /**
   * The secret Google echoes in X-Goog-Channel-Token. AES-256-GCM, bound to
   * the business and to the purpose 'watch_token'. Never selectable by a
   * signed-in user -- see the column grants below.
   */
  token_encrypted text not null,

  expires_at timestamptz not null,
  created_at timestamptz not null default now(),

  /** Set when the channel is replaced or its connection is disconnected. */
  stopped_at timestamptz
);

comment on table public.integration_watch_channels is
  'Google change-notification channels. They expire within a day and are '
  'renewed; a notification is matched to its connection by channel_id.';

create index integration_watch_channels_account_idx
  on public.integration_watch_channels (integration_account_id)
  where stopped_at is null;

create index integration_watch_channels_expiry_idx
  on public.integration_watch_channels (expires_at)
  where stopped_at is null;


-- ----------------------------------------------------------------------------
-- 2. Record state
-- ----------------------------------------------------------------------------

create table public.integration_record_state (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  integration_account_id uuid not null references public.integration_accounts (id) on delete cascade,

  entity text not null check (entity in ('ORDERS', 'PRODUCTS', 'EXPENSES')),

  /** The owner-confirmed business key: Order ID, SKU or Reference. */
  business_key text not null check (length(business_key) between 1 and 500),

  /**
   * A hash of the source content the record was built from, INCLUDING the
   * mapping it was read with -- so changing a mapping changes every
   * fingerprint and forces a full re-apply. Computed in the application;
   * nothing here interprets it.
   */
  content_hash text not null,

  /** APPLIED, or REJECTED by validation (so "3 rows cannot be imported" is stable). */
  last_outcome text not null check (last_outcome in ('APPLIED', 'REJECTED')),

  /**
   * Where it was last seen: sheet title and row number AT THAT SYNC. For a
   * person reading history. Never an identity.
   */
  locator jsonb not null default '{}'::jsonb,

  present          boolean not null default true,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  last_changed_at  timestamptz not null default now(),
  last_seen_run_id uuid references public.sync_runs (id) on delete set null,

  unique (integration_account_id, entity, business_key)
);

comment on table public.integration_record_state is
  'One fingerprint per business record per connection. Lets a re-read skip '
  'unchanged records, and reports records that vanished from the source '
  'without ever deleting them.';

create index integration_record_state_business_idx
  on public.integration_record_state (business_id);


-- ----------------------------------------------------------------------------
-- 3. Row Level Security and privileges
-- ----------------------------------------------------------------------------
-- Supabase's default privileges grant ALL on a new table to anon and
-- authenticated before a line of this migration runs, so everything is revoked
-- first and only what is needed is granted back. A column-level REVOKE cannot
-- undo a table-level GRANT -- 0012 learned both of these the hard way.
--
-- Members may READ both tables (connection health, sync history). Nobody signed
-- in may write to either: they are written only by the trusted functions below.

alter table public.integration_watch_channels enable row level security;
alter table public.integration_watch_channels force row level security;
alter table public.integration_record_state enable row level security;
alter table public.integration_record_state force row level security;

create policy integration_watch_channels_select_member
  on public.integration_watch_channels for select to authenticated
  using (business_id in (select public.current_user_business_ids()));

create policy integration_record_state_select_member
  on public.integration_record_state for select to authenticated
  using (business_id in (select public.current_user_business_ids()));

revoke all on public.integration_watch_channels from anon, authenticated;
revoke all on public.integration_record_state from anon, authenticated;

-- The token column is deliberately absent. Granted column by column so it can
-- never be reached by `select *`.
grant select (id, business_id, integration_account_id, channel_id, resource_id,
              expires_at, created_at, stopped_at)
  on public.integration_watch_channels to authenticated;

grant select on public.integration_record_state to authenticated;

grant select, insert, update, delete on public.integration_watch_channels to service_role;
grant select, insert, update, delete on public.integration_record_state to service_role;


-- ----------------------------------------------------------------------------
-- 4. Record state: classify, then commit
-- ----------------------------------------------------------------------------
-- Every function takes a JOB id and derives the connection, business and
-- entity from it. None takes a business id, so none can be pointed at another
-- tenant -- the rule callTrusted() enforces on the application side.

/**
 * Which records on this page are new, changed, or unchanged.
 *
 * Read-only. p_items: [{ "key": "ORD-1001", "hash": "..." }, ...]
 */
create or replace function public.sync_record_state_classify(
  p_job_id uuid,
  p_items  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.sync_jobs;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  return (
    with items as (
      select distinct on (e.item ->> 'key')
        e.item ->> 'key'  as k,
        e.item ->> 'hash' as h
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
      where nullif(e.item ->> 'key', '') is not null
    ),
    joined as (
      select it.k, it.h, s.content_hash
      from items it
      left join public.integration_record_state s
        on s.integration_account_id = v_job.integration_account_id
       and s.entity = v_job.resource
       and s.business_key = it.k
    )
    select jsonb_build_object(
      'new',
        coalesce(jsonb_agg(j.k) filter (where j.content_hash is null), '[]'::jsonb),
      'changed',
        coalesce(jsonb_agg(j.k) filter (
          where j.content_hash is not null and j.content_hash is distinct from j.h
        ), '[]'::jsonb),
      'unchanged',
        count(*) filter (where j.content_hash = j.h)
    )
    from joined j
  );
end;
$$;


/**
 * Records what was seen on this page, AFTER it was applied.
 *
 * p_items: [{ "key", "hash", "outcome": "APPLIED"|"REJECTED"|null, "locator": {} }]
 * An item with no outcome was unchanged: its last outcome is kept and only
 * last_seen moves, which is what missing-record detection relies on.
 *
 * Returns how many records were written.
 */
create or replace function public.sync_record_state_commit(
  p_job_id uuid,
  p_run_id uuid,
  p_items  jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.sync_jobs;
  v_count integer;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  if v_job.resource not in ('ORDERS', 'PRODUCTS', 'EXPENSES') then
    raise exception 'Record state is kept only for orders, products and expenses.'
      using errcode = 'P0001';
  end if;

  insert into public.integration_record_state (
    business_id, integration_account_id, entity, business_key, content_hash,
    last_outcome, locator, present, first_seen_at, last_seen_at,
    last_changed_at, last_seen_run_id
  )
  select
    v_job.business_id, v_job.integration_account_id, v_job.resource,
    d.item ->> 'key',
    d.item ->> 'hash',
    -- A brand-new record must say how it went. Defaulting to APPLIED would
    -- report a rejected row as imported.
    coalesce(nullif(d.item ->> 'outcome', ''), 'REJECTED'),
    coalesce(d.item -> 'locator', '{}'::jsonb),
    true, now(), now(), now(), p_run_id
  from (
    select distinct on (e.item ->> 'key') e.item
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
    where nullif(e.item ->> 'key', '') is not null
      and nullif(e.item ->> 'hash', '') is not null
  ) d
  on conflict (integration_account_id, entity, business_key) do update set
    last_changed_at = case
      when public.integration_record_state.content_hash
           is distinct from excluded.content_hash then now()
      else public.integration_record_state.last_changed_at
    end,
    content_hash     = excluded.content_hash,
    -- NULL outcome = unchanged: keep what it was.
    last_outcome     = case
      when excluded.last_outcome is not null
           and public.integration_record_state.content_hash
               is distinct from excluded.content_hash
        then excluded.last_outcome
      else public.integration_record_state.last_outcome
    end,
    locator          = excluded.locator,
    present          = true,
    last_seen_at     = now(),
    last_seen_run_id = excluded.last_seen_run_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


/**
 * After a COMPLETE pass: marks records not seen since the pass began as no
 * longer present, and returns how many are missing in total.
 *
 * Marks, never deletes. The count is what an owner is shown.
 */
create or replace function public.sync_record_state_mark_missing(
  p_job_id          uuid,
  p_pass_started_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.sync_jobs;
  v_missing integer;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  update public.integration_record_state
  set present = false
  where integration_account_id = v_job.integration_account_id
    and entity = v_job.resource
    and present
    and last_seen_at < p_pass_started_at;

  select count(*) into v_missing
  from public.integration_record_state
  where integration_account_id = v_job.integration_account_id
    and entity = v_job.resource
    and not present;

  return v_missing;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Watch channels: register, look up, stop, renew
-- ----------------------------------------------------------------------------

/** Records a channel BizMind has just created with Google. */
create or replace function public.watch_channel_register(
  p_account_id      uuid,
  p_channel_id      text,
  p_resource_id     text,
  p_token_encrypted text,
  p_expires_at      timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_status   public.integration_status;
  v_id       uuid;
begin
  select a.business_id, a.status into v_business, v_status
  from public.integration_accounts a
  where a.id = p_account_id;

  if v_business is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if v_status = 'DISCONNECTED' then
    raise exception 'That connection has been disconnected.' using errcode = 'P0001';
  end if;

  insert into public.integration_watch_channels (
    business_id, integration_account_id, channel_id, resource_id,
    token_encrypted, expires_at
  )
  values (
    v_business, p_account_id, p_channel_id, p_resource_id,
    p_token_encrypted, p_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$$;


/**
 * Resolves a notification's channel to its connection.
 *
 * THE ONLY SOURCE OF THE TENANT for a Google notification. The channel id
 * comes from a request header and is untrusted until it matches a row here --
 * and even then nothing is written until the token has been verified.
 */
create or replace function public.watch_channel_lookup(p_channel_id text)
returns table (
  watch_id             uuid,
  account_id           uuid,
  resolved_business_id uuid,
  token_encrypted      text,
  account_status       public.integration_status,
  resource_id          text,
  expires_at           timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select w.id, a.id, w.business_id, w.token_encrypted, a.status,
         w.resource_id, w.expires_at
  from public.integration_watch_channels w
  join public.integration_accounts a on a.id = w.integration_account_id
  where w.channel_id = p_channel_id
    and w.stopped_at is null
    and a.status <> 'DISCONNECTED';
$$;


/**
 * Records one Google notification, and -- if it was genuine and means the
 * content changed -- queues a sync of that connection.
 *
 * Mirrors webhook_event_ingest(): the tenant comes from the channel row,
 * redeliveries are decided by the unique idempotency key, and a notification
 * that failed verification is recorded and refused.
 *
 * It enqueues in the same transaction rather than leaving the event for the
 * webhook processor, because a Google notification has no records to apply --
 * the only thing to do with it is ask for a sync.
 */
create or replace function public.watch_event_ingest(
  p_channel_id     text,
  p_message_number text,
  p_resource_state text,
  p_changed        text,
  p_raw            text,
  p_token_valid    boolean
)
returns table (
  outcome   text,   -- ACCEPTED | DUPLICATE | REJECTED | UNKNOWN_CHANNEL
  event_id  uuid,
  /** Not `business_id`: an OUT parameter shares scope with column names. */
  resolved_business_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_watch      public.integration_watch_channels;
  v_status     public.integration_status;
  v_entity     text;
  v_external   text;
  v_key        text;
  v_event_id   uuid;
  v_actionable boolean;
begin
  select * into v_watch
  from public.integration_watch_channels w
  where w.channel_id = p_channel_id and w.stopped_at is null;

  if v_watch.id is null then
    return query select 'UNKNOWN_CHANNEL'::text, null::uuid, null::uuid;
    return;
  end if;

  select a.status, a.metadata ->> 'entity' into v_status, v_entity
  from public.integration_accounts a
  where a.id = v_watch.integration_account_id;

  v_external := p_channel_id || ':' || coalesce(p_message_number, '');
  v_key      := 'GOOGLE_SHEETS:' || v_external;

  -- 'sync' is Google's handshake when a channel is created: nothing changed.
  -- A content change arrives as 'update' (X-Goog-Changed includes 'content');
  -- trash/remove also warrant a sync, which is how the connector discovers
  -- the file is gone and reports it.
  v_actionable := p_token_valid
    and p_resource_state in ('update', 'change', 'add', 'trash', 'remove')
    and (p_resource_state <> 'update'
         or p_changed is null
         or p_changed ilike '%content%');

  insert into public.webhook_events (
    business_id, integration_account_id, provider, event_type,
    external_event_id, idempotency_key, raw_body, signature_valid,
    status, next_run_at
  )
  values (
    v_watch.business_id, v_watch.integration_account_id,
    'GOOGLE_SHEETS'::public.integration_provider,
    'drive.' || coalesce(p_resource_state, 'unknown'),
    v_external, v_key, coalesce(p_raw, ''), p_token_valid,
    -- Explicit casts: a CASE of bare literals is text, and text will not go
    -- into an enum column (42804 -- the fault that broke every delivery in 0012).
    (case when p_token_valid then 'PROCESSED' else 'REJECTED' end)
      ::public.webhook_event_status,
    null::timestamptz
  )
  on conflict (business_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select e.id into v_event_id
    from public.webhook_events e
    where e.business_id = v_watch.business_id and e.idempotency_key = v_key;

    return query select 'DUPLICATE'::text, v_event_id, v_watch.business_id;
    return;
  end if;

  if not p_token_valid then
    -- Audited: a burst of these is an attack, and one nobody can see is worse
    -- than one that fills a table. Genuine change signals are NOT audited --
    -- an owner editing a sheet produces one per burst of edits, and every one
    -- is already in webhook_events.
    insert into public.audit_logs
      (business_id, actor_id, action, entity_type, entity_id, after_data)
    values (
      v_watch.business_id, null, 'integration.webhook.rejected',
      'webhook_events', v_event_id,
      jsonb_build_object('provider', 'GOOGLE_SHEETS', 'channel_id', p_channel_id)
    );

    return query select 'REJECTED'::text, v_event_id, v_watch.business_id;
    return;
  end if;

  -- Twenty seconds' grace: people edit in bursts, and one sync after the
  -- burst is better than one per keystroke. sync_enqueue_system() also
  -- declines to queue for a paused, disconnected or broken connection.
  if v_actionable and v_entity is not null then
    perform public.sync_enqueue_system(
      v_watch.integration_account_id, v_entity,
      'AUTOMATIC'::public.sync_trigger, 20
    );
  end if;

  return query select 'ACCEPTED'::text, v_event_id, v_watch.business_id;
end;
$$;


/** Marks a channel stopped. The application also calls Google's channels.stop. */
create or replace function public.watch_channel_stop(p_channel_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.integration_watch_channels
  set stopped_at = now()
  where channel_id = p_channel_id and stopped_at is null;

  return found;
end;
$$;


/**
 * Connections that need a channel: none active, or the active one expiring
 * within the window. Across every business, because renewal is a scheduled
 * job with no session -- and it returns ids only, never a token.
 */
create or replace function public.watch_renewals_due(
  p_within_seconds integer default 7200,
  p_limit          integer default 50
)
returns table (
  account_id          uuid,
  current_channel_id  text,
  current_resource_id text,
  current_expires_at  timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select a.id, w.channel_id, w.resource_id, w.expires_at
  from public.integration_accounts a
  left join lateral (
    select c.channel_id, c.resource_id, c.expires_at
    from public.integration_watch_channels c
    where c.integration_account_id = a.id and c.stopped_at is null
    order by c.expires_at desc
    limit 1
  ) w on true
  where a.provider = 'GOOGLE_SHEETS'
    and a.status in ('CONNECTED', 'ERROR')
    and (w.channel_id is null
         or w.expires_at < now() + make_interval(secs => p_within_seconds))
  order by coalesce(w.expires_at, a.connected_at)
  limit p_limit;
$$;


/**
 * The safety net: queues a reconciliation for Google Sheets connections that
 * have not been checked within the interval. Returns how many were queued.
 *
 * It is a BACKUP for missed notifications, not the way changes normally
 * arrive. The connector compares the file's Drive `version` first, so a
 * reconciliation of an unchanged sheet costs one small API call and no read.
 *
 * Skips connections that are paused, need reauthorisation or a mapping review,
 * already have work queued or running, or are dead-lettered -- re-queuing a
 * permanent failure every fifteen minutes would be a retry storm that fixes
 * nothing.
 */
create or replace function public.sync_reconcile_due(
  p_interval_minutes integer default 15,
  p_limit            integer default 50
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_entity  text;
  v_count   integer := 0;
begin
  for v_account, v_entity in
    select a.id, a.metadata ->> 'entity'
    from public.integration_accounts a
    where a.provider = 'GOOGLE_SHEETS'
      and a.status = 'CONNECTED'
      and a.metadata ->> 'entity' in ('ORDERS', 'PRODUCTS', 'EXPENSES')
      and coalesce(a.last_attempted_sync_at, a.connected_at)
            < now() - make_interval(mins => p_interval_minutes)
      and not exists (
        select 1 from public.sync_jobs j
        where j.integration_account_id = a.id
          and j.status in ('QUEUED', 'RUNNING', 'RETRYING', 'DEAD_LETTER')
      )
    order by coalesce(a.last_attempted_sync_at, a.connected_at)
    limit p_limit
  loop
    perform public.sync_enqueue_system(
      v_account, v_entity, 'RECONCILIATION'::public.sync_trigger, 0
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Function privileges
-- ----------------------------------------------------------------------------
-- Every one of these is session-less and service_role only. Supabase's default
-- privileges also grant EXECUTE on new functions to anon and authenticated, so
-- it is revoked explicitly.

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.sync_record_state_classify(uuid, jsonb)',
    'public.sync_record_state_commit(uuid, uuid, jsonb)',
    'public.sync_record_state_mark_missing(uuid, timestamptz)',
    'public.watch_channel_register(uuid, text, text, text, timestamptz)',
    'public.watch_channel_lookup(text)',
    'public.watch_event_ingest(text, text, text, text, text, boolean)',
    'public.watch_channel_stop(text)',
    'public.watch_renewals_due(integer, integer)',
    'public.sync_reconcile_due(integer, integer)'
  ]
  loop
    execute format('revoke all on function %s from anon, authenticated, public', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t      text;
  v_fn   text;
  v_rls  boolean;
  v_frc  boolean;
begin
  foreach t in array array['integration_watch_channels', 'integration_record_state']
  loop
    select c.relrowsecurity, c.relforcerowsecurity into v_rls, v_frc
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true or v_frc is not true then
      raise exception 'SECURITY: RLS is not enabled and forced on public.%', t;
    end if;

    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'SECURITY: anon can read public.%', t;
    end if;

    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'SECURITY: a signed-in user can write to public.%', t;
    end if;
  end loop;

  if has_column_privilege('authenticated',
       'public.integration_watch_channels', 'token_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integration_watch_channels.token_encrypted';
  end if;

  if not has_column_privilege('authenticated',
       'public.integration_watch_channels', 'expires_at', 'SELECT') then
    raise exception 'Members cannot see when a watch channel expires.';
  end if;

  foreach v_fn in array array[
    'sync_record_state_classify', 'sync_record_state_commit',
    'sync_record_state_mark_missing', 'watch_channel_register',
    'watch_channel_lookup', 'watch_event_ingest', 'watch_channel_stop',
    'watch_renewals_due', 'sync_reconcile_due'
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

  raise notice
    'Migration 0021 verified: watch channels and record state exist, RLS is '
    'enabled and forced, the channel token is unreadable by signed-in users, '
    'and every new function is service_role only.';
end;
$$;


commit;
