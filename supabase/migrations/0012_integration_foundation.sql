-- ============================================================================
-- 0012  Integration foundation: connections, sync engine, webhook events
-- ============================================================================
-- The infrastructure a real connector plugs into. No provider is implemented
-- here; nothing in this migration knows what Shopify or WooCommerce is.
--
-- THE PROBLEM THIS SOLVES FIRST
-- ----------------------------
-- Every other table in this database is protected by Row Level Security keyed
-- on `auth.uid()`. A webhook has no session. `write_audit_log()` raises
-- '28000 Not authenticated' when called without one, so the session-less path
-- cannot even record what it did.
--
-- So the trusted path is built explicitly, and narrowly:
--
--   provider + external account id  ->  integration_accounts  ->  business_id
--
-- The business is DERIVED from a connection row that an authenticated owner
-- created. It is never read from a request body, a header, or a query
-- parameter. An unrecognised account resolves to nothing and the event is
-- dropped -- it is not guessed at, and it does not become somebody else's.
--
-- The functions that need to work without a session are SECURITY DEFINER and
-- are granted to `service_role` ONLY. They are unreachable by `anon` and by
-- `authenticated`, so the only way to call one is from the server-side module
-- that holds the key. Each resolves the tenant itself and takes no business_id
-- argument, so there is no parameter to point at another tenant.
--
-- WHAT IS NOT HERE
-- ----------------
-- No money. No analytics. Nothing in this migration produces a figure, and
-- nothing a connector writes bypasses the existing ingestion pipeline:
-- a connector produces raw records, and `import_apply_*` writes them, exactly
-- as the CSV importer does.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Vocabulary
-- ----------------------------------------------------------------------------

create type public.integration_provider as enum (
  'FIXTURE',       -- deterministic in-repo connector; proves the engine
  'WOOCOMMERCE',
  'SHOPIFY'
);

create type public.integration_status as enum (
  'CONNECTED',
  'ERROR',         -- credentials or the provider are failing; data is intact
  'DISCONNECTED'   -- deliberately revoked
);

create type public.sync_mode as enum ('INITIAL', 'INCREMENTAL');

create type public.sync_status as enum (
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',       -- some records applied, some rejected. Cursor still advanced
  'RETRYING',
  'FAILED',
  'DEAD_LETTER'    -- out of attempts. Needs a person
);

create type public.webhook_event_status as enum (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'DUPLICATE',     -- a redelivery. Recorded, and deliberately does nothing
  'FAILED',
  'DEAD_LETTER',
  'REJECTED'       -- signature did not verify
);


-- ----------------------------------------------------------------------------
-- 2. integrations -- which providers a business uses
-- ----------------------------------------------------------------------------

create table public.integrations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider    public.integration_provider not null,
  status      public.integration_status not null default 'CONNECTED',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, provider)
);

comment on table public.integrations is
  'One row per provider a business uses. The accounts beneath it hold the '
  'actual store connections.';


-- ----------------------------------------------------------------------------
-- 3. integration_accounts -- one connected store, with a STABLE identity
-- ----------------------------------------------------------------------------
-- `external_account_id` is the provider's own permanent name for the store:
-- a myshopify.com domain, a WooCommerce site URL. It is the reconnection key.
--
-- Reconnecting the same store must not produce a second channel and split the
-- history in two, so connect is an UPSERT on
-- (business_id, integration_id, external_account_id) and the channel is
-- carried across untouched.

create table public.integration_accounts (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  integration_id uuid not null references public.integrations (id) on delete cascade,

  /** The provider's stable identity for this store. Never a display name. */
  external_account_id text not null,
  display_name        text,

  status public.integration_status not null default 'CONNECTED',

  /** Sales from this store land on this channel. Reused across reconnects. */
  channel_id uuid references public.channels (id) on delete set null,

  /**
   * AES-256-GCM ciphertext produced by src/lib/crypto.ts. The key lives in an
   * environment variable, never in this database -- so a database backup on
   * its own does not yield a usable credential.
   *
   * Never selected by client-facing code. See the column-level revoke below.
   */
  credentials_encrypted   text,
  webhook_secret_encrypted text,

  /** Non-sensitive facts worth showing: API version, scopes, store name. */
  metadata jsonb not null default '{}'::jsonb,

  last_successful_sync_at timestamptz,
  last_attempted_sync_at  timestamptz,
  last_error              text,

  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  revoked_at   timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, integration_id, external_account_id)
);

comment on table public.integration_accounts is
  'One connected store. external_account_id is the provider''s stable identity '
  'and the key that makes reconnecting idempotent.';

comment on column public.integration_accounts.credentials_encrypted is
  'AES-256-GCM ciphertext. The key is in the environment, not the database.';

/**
 * A live store belongs to exactly one BizMind business.
 *
 * Without this, the same Shopify shop could be connected by two customers and
 * a webhook would resolve ambiguously -- which is a cross-tenant data leak
 * wearing the costume of a feature request. Partial, so a store can be
 * disconnected and later connected by a different business.
 */
create unique index integration_accounts_live_external_key
  on public.integration_accounts (integration_id, external_account_id)
  where status <> 'DISCONNECTED';

/** The webhook resolution path. Must be fast and must be unique. */
create index integration_accounts_provider_lookup
  on public.integration_accounts (external_account_id)
  where status <> 'DISCONNECTED';

create index integration_accounts_business_idx
  on public.integration_accounts (business_id, status);

create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

create trigger integration_accounts_set_updated_at
  before update on public.integration_accounts
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. sync_jobs -- what should be synced, and when
-- ----------------------------------------------------------------------------
-- One row per (account, resource). A job is a standing schedule entry, not a
-- single execution: it flips from INITIAL to INCREMENTAL after the first
-- successful pass and keeps its cursor. The unique constraint is what stops a
-- double-click enqueuing two competing syncs of the same data.

create table public.sync_jobs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  integration_account_id uuid not null
    references public.integration_accounts (id) on delete cascade,

  resource text not null check (resource in ('ORDERS','PRODUCTS','CUSTOMERS','INVENTORY')),
  mode     public.sync_mode not null default 'INITIAL',
  status   public.sync_status not null default 'QUEUED',

  /** Provider-opaque checkpoint. Written only after a page is durably applied. */
  cursor   text,

  priority smallint not null default 100,
  next_run_at timestamptz not null default now(),

  attempts     integer not null default 0,
  max_attempts integer not null default 7,

  /** Claim fields. A worker holds a job for a bounded time, then it is free. */
  locked_at    timestamptz,
  locked_until timestamptz,
  locked_by    text,

  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (integration_account_id, resource)
);

comment on table public.sync_jobs is
  'A standing schedule entry per account and resource. Holds the cursor, the '
  'retry count, and the claim.';

create index sync_jobs_claimable_idx
  on public.sync_jobs (status, next_run_at, priority)
  where status in ('QUEUED', 'RETRYING');

create index sync_jobs_business_idx on public.sync_jobs (business_id);

create trigger sync_jobs_set_updated_at
  before update on public.sync_jobs
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 5. sync_runs -- what actually happened, once per attempt
-- ----------------------------------------------------------------------------
-- A job is intent; a run is history. Keeping them apart is what makes
-- "this store has failed four nights running, always at the same cursor" a
-- question the database can answer.

create table public.sync_runs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  job_id      uuid not null references public.sync_jobs (id) on delete cascade,

  attempt      integer not null,
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  status       public.sync_status not null default 'RUNNING',

  records_fetched integer not null default 0,
  records_applied integer not null default 0,
  records_skipped integer not null default 0,

  cursor_before text,
  cursor_after  text,

  /** A summary for a person. Never a stack trace, never a credential. */
  error_summary text
);

create index sync_runs_job_idx on public.sync_runs (job_id, started_at desc);
create index sync_runs_business_idx on public.sync_runs (business_id, started_at desc);


-- ----------------------------------------------------------------------------
-- 6. sync_logs -- the detail, bounded, and never secret
-- ----------------------------------------------------------------------------

create table public.sync_logs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  run_id      uuid references public.sync_runs (id) on delete cascade,

  level     text not null check (level in ('DEBUG','INFO','WARN','ERROR')),
  provider  public.integration_provider,
  operation text not null,
  duration_ms integer,

  /**
   * Request and response metadata ONLY. No headers, no bodies, no tokens.
   * scripts/verify-integration-security.mts scans this table's writers for
   * credential-shaped strings.
   */
  context jsonb not null default '{}'::jsonb,
  error   text,

  created_at timestamptz not null default now()
);

create index sync_logs_run_idx on public.sync_logs (run_id, created_at);
create index sync_logs_business_idx on public.sync_logs (business_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 7. webhook_events -- the raw truth, kept, and deduplicated by the database
-- ----------------------------------------------------------------------------

create table public.webhook_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  integration_account_id uuid not null
    references public.integration_accounts (id) on delete cascade,

  provider   public.integration_provider not null,
  event_type text not null,

  /** The provider's own delivery id. */
  external_event_id text not null,

  /**
   * The idempotency key, and the whole duplicate-prevention mechanism.
   *
   * A unique constraint, not an application-level "if exists" check: two
   * concurrent redeliveries both pass an existence check and both insert.
   * Only the database can decide this once.
   */
  idempotency_key text not null,

  /** Exactly as received. The evidence, and what a replay re-reads. */
  raw_body text not null,

  signature_valid boolean not null,

  status public.webhook_event_status not null default 'RECEIVED',

  received_at  timestamptz not null default now(),
  processed_at timestamptz,

  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at  timestamptz,
  last_error   text,

  unique (business_id, idempotency_key)
);

comment on table public.webhook_events is
  'Every delivery, kept verbatim. The unique idempotency key is what makes a '
  'redelivery free.';

create index webhook_events_processable_idx
  on public.webhook_events (status, next_run_at)
  where status in ('RECEIVED', 'FAILED');

create index webhook_events_account_idx
  on public.webhook_events (integration_account_id, received_at desc);

create index webhook_events_business_idx
  on public.webhook_events (business_id, received_at desc);


-- ----------------------------------------------------------------------------
-- 8. Row Level Security
-- ----------------------------------------------------------------------------
-- Read for any member; write restricted. Note what is NOT granted: nothing
-- here is writable by `anon`, and the session-less functions in section 9 do
-- not rely on these policies at all -- they are SECURITY DEFINER and reachable
-- only by service_role.

do $$
declare
  t text;
begin
  foreach t in array array[
    'integrations', 'integration_accounts', 'sync_jobs',
    'sync_runs', 'sync_logs', 'webhook_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);

    -- Only an owner or admin may connect a store, schedule a sync, or replay
    -- an event. Those are decisions about someone's money and someone's data.
    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_insert_admin', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_update_admin', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER']::public.business_role[]))
    $f$, t || '_delete_owner', t);

    execute format('revoke all on public.%I from anon', t);

    -- integration_accounts is granted separately, column by column. A
    -- table-wide SELECT here would make the credential columns readable and
    -- COULD NOT BE TAKEN BACK: see the note below.
    if t <> 'integration_accounts' then
      execute format(
        'grant select, insert, update, delete on public.%I to authenticated', t);
    end if;
  end loop;
end;
$$;

/**
 * Credentials are never readable or writable by a signed-in user.
 *
 * RLS decides which ROWS are visible; a column grant decides which COLUMNS.
 * Without this, an owner could read their own encrypted tokens through
 * PostgREST -- and "encrypted" is not "safe to hand to a browser".
 *
 * THIS IS A GRANT LIST, NOT A REVOKE LIST, AND THAT MATTERS.
 *
 * The first version of this migration granted SELECT on the whole table and
 * then revoked two columns. That does nothing: in PostgreSQL a column-level
 * REVOKE cannot remove a table-level GRANT. Table-wide SELECT means SELECT on
 * every column, and there is no way to subtract one afterwards.
 *
 * The migration's own verification block caught it and refused to install --
 * which is exactly why that block asserts privileges rather than trusting that
 * the statements above did what they read as doing.
 *
 * So the privilege is never granted in the first place. Every column is listed
 * except the two that hold secrets. Adding a column to this table means adding
 * it here, and forgetting to means it is invisible rather than exposed -- the
 * safe direction to fail in.
 */
grant select (
  id, business_id, integration_id, external_account_id, display_name,
  status, channel_id, metadata, last_successful_sync_at,
  last_attempted_sync_at, last_error, connected_by, connected_at,
  revoked_at, created_at, updated_at
) on public.integration_accounts to authenticated;

grant insert (
  id, business_id, integration_id, external_account_id, display_name,
  status, channel_id, metadata, last_successful_sync_at,
  last_attempted_sync_at, last_error, connected_by, connected_at,
  revoked_at, created_at, updated_at
) on public.integration_accounts to authenticated;

grant update (
  id, business_id, integration_id, external_account_id, display_name,
  status, channel_id, metadata, last_successful_sync_at,
  last_attempted_sync_at, last_error, connected_by, connected_at,
  revoked_at, created_at, updated_at
) on public.integration_accounts to authenticated;

grant delete on public.integration_accounts to authenticated;


-- ----------------------------------------------------------------------------
-- 9. The session-less path
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER, granted to service_role ONLY.
--
-- Each function resolves the tenant itself from a connection row. None of them
-- accepts a business_id, so there is no argument an attacker could point at
-- another tenant even with the ability to call them.

/**
 * Records one delivery.
 *
 * Signature verification has already happened in the application, next to the
 * decrypted secret and `crypto.timingSafeEqual`. This function's job is the
 * part only the database can do correctly: resolve the tenant, and decide
 * exactly once whether this delivery is new.
 */
create or replace function public.webhook_event_ingest(
  p_provider          public.integration_provider,
  p_external_account_id text,
  p_external_event_id text,
  p_event_type        text,
  p_raw_body          text,
  p_signature_valid   boolean
)
returns table (
  outcome    text,   -- ACCEPTED | DUPLICATE | REJECTED | UNKNOWN_ACCOUNT
  event_id   uuid,
  /**
   * Named `resolved_` rather than `business_id` deliberately.
   *
   * In a plpgsql function an OUT parameter is a variable in scope, and a
   * variable sharing a name with a column makes `on conflict (business_id, ...)`
   * ambiguous. The lookup functions beside this one are `language sql`, where
   * no such substitution happens -- this is the one that needed the care.
   */
  resolved_business_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  public.integration_accounts;
  v_key      text := p_provider::text || ':' || p_external_event_id;
  v_event_id uuid;
begin
  -- TRUSTED BUSINESS RESOLUTION. The only source of truth for the tenant.
  select a.* into v_account
  from public.integration_accounts a
  join public.integrations i on i.id = a.integration_id
  where i.provider = p_provider
    and a.external_account_id = p_external_account_id
    and a.status <> 'DISCONNECTED'
  limit 1;

  if v_account.id is null then
    -- Nothing is written. An unknown store is not a tenant, and inventing one
    -- is how a forged delivery becomes somebody's data.
    return query select 'UNKNOWN_ACCOUNT'::text, null::uuid, null::uuid;
    return;
  end if;

  -- A rejected delivery is still recorded: a burst of them is an attack, and
  -- an attack nobody can see is worse than one that fills a table.
  insert into public.webhook_events (
    business_id, integration_account_id, provider, event_type,
    external_event_id, idempotency_key, raw_body, signature_valid,
    status, next_run_at
  )
  values (
    v_account.business_id, v_account.id, p_provider, p_event_type,
    p_external_event_id, v_key, p_raw_body, p_signature_valid,
    case when p_signature_valid then 'RECEIVED' else 'REJECTED' end,
    case when p_signature_valid then now() end
  )
  on conflict (business_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- The unique constraint refused it. This is the redelivery path and it is
    -- the normal case: every provider retries.
    select e.id into v_event_id
    from public.webhook_events e
    where e.business_id = v_account.business_id and e.idempotency_key = v_key;

    return query select 'DUPLICATE'::text, v_event_id, v_account.business_id;
    return;
  end if;

  -- Audited here rather than through write_audit_log(), which requires a
  -- session this path does not have.
  insert into public.audit_logs
    (business_id, actor_id, action, entity_type, entity_id, after_data)
  values (
    v_account.business_id, null,
    case when p_signature_valid
         then 'integration.webhook.received'
         else 'integration.webhook.rejected' end,
    'webhook_events', v_event_id,
    jsonb_build_object(
      'provider', p_provider,
      'event_type', p_event_type,
      'external_event_id', p_external_event_id,
      'signature_valid', p_signature_valid
    )
  );

  return query select
    case when p_signature_valid then 'ACCEPTED' else 'REJECTED' end,
    v_event_id,
    v_account.business_id;
end;
$$;


/**
 * Resolves a delivery's account, and returns the sealed webhook secret.
 *
 * This is the lookup that turns an untrusted "the provider says this is store
 * X" into a tenant. It is separate from ingest because verification happens
 * between them: the secret has to be decrypted in the application, next to
 * Node's `timingSafeEqual` and the encryption key, which is deliberately not
 * in this database.
 *
 * Returns nothing for an unknown or disconnected store. Nothing is written,
 * and no tenant is invented.
 */
create or replace function public.webhook_account_lookup(
  p_provider          public.integration_provider,
  p_external_account_id text
)
returns table (
  account_id  uuid,
  resolved_business_id uuid,
  webhook_secret_encrypted text,
  account_status public.integration_status
)
language sql
security definer
set search_path = ''
as $$
  select a.id, a.business_id, a.webhook_secret_encrypted, a.status
  from public.integration_accounts a
  join public.integrations i on i.id = a.integration_id
  where i.provider = p_provider
    and a.external_account_id = p_external_account_id
    and a.status <> 'DISCONNECTED'
  limit 1;
$$;


/**
 * Claims work for one worker.
 *
 * FOR UPDATE SKIP LOCKED is what makes two workers safe: the second walks past
 * a row the first is holding rather than blocking on it or duplicating it.
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
    where c.status in ('QUEUED', 'RETRYING')
      and c.next_run_at <= now()
      and (c.locked_until is null or c.locked_until < now())
    order by c.priority, c.next_run_at
    for update skip locked
    limit p_limit
  )
  returning j.*;
$$;


/**
 * Records the outcome of one attempt and decides what happens next.
 *
 * The backoff is computed here, in SQL, because the schedule is a property of
 * the system rather than of whichever worker happened to run.
 *
 * FULL JITTER: the delay is a random point in [0, exponential]. Without it a
 * thousand connections failing on one provider outage retry in lockstep and
 * become the outage.
 */
create or replace function public.sync_job_complete(
  p_job_id  uuid,
  p_run_id  uuid,
  p_status  public.sync_status,
  p_cursor  text,
  p_records_fetched integer,
  p_records_applied integer,
  p_records_skipped integer,
  p_error   text default null,
  p_retry_after_ms integer default null   -- provider asked us to wait
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
      cursor_after    = p_cursor,
      error_summary   = p_error
  where id = p_run_id;

  if p_status in ('SUCCEEDED', 'PARTIAL') then
    update public.sync_jobs
    set status       = p_status,
        cursor       = coalesce(p_cursor, cursor),
        -- The first successful pass turns a backfill into a watch.
        mode         = case when mode = 'INITIAL' then 'INCREMENTAL' else mode end,
        attempts     = 0,
        locked_at    = null,
        locked_until = null,
        locked_by    = null,
        last_error   = null,
        next_run_at  = now() + interval '1 hour'
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
    where id = v_job.integration_account_id;

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


/** Opens a run. Separate from claiming so an attempt is always on record. */
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
    (business_id, job_id, attempt, cursor_before, status)
  values (v_job.business_id, v_job.id, v_job.attempts, v_job.cursor, 'RUNNING')
  returning * into v_run;

  return v_run;
end;
$$;


/**
 * Everything a worker needs to run one job, resolved from the job itself.
 *
 * The worker supplies a job id and gets back a tenant. It never supplies a
 * tenant and gets back a job -- which is the same rule as everywhere else on
 * this path, stated in the shape of a function signature.
 */
create or replace function public.sync_job_context(p_job_id uuid)
returns table (
  job_id            uuid,
  resolved_business_id uuid,
  account_id        uuid,
  provider          public.integration_provider,
  external_account_id text,
  credentials_encrypted text,
  metadata          jsonb,
  resource          text,
  mode              public.sync_mode,
  cursor_value      text,
  account_status    public.integration_status
)
language sql
security definer
set search_path = ''
as $$
  select
    j.id, j.business_id, a.id, i.provider, a.external_account_id,
    a.credentials_encrypted, a.metadata, j.resource, j.mode, j.cursor, a.status
  from public.sync_jobs j
  join public.integration_accounts a on a.id = j.integration_account_id
  join public.integrations i on i.id = a.integration_id
  where j.id = p_job_id;
$$;


/**
 * Writes a page of synced orders through the EXISTING ingestion pipeline.
 *
 * A connector never touches a business table. It produces raw records and they
 * are applied by `import_apply_orders` -- the same function the CSV importer
 * uses, with the same validation, the same idempotency on
 * (business_id, source, external_id), and the same refusal to turn a blank
 * into a zero.
 *
 * The batch is created here rather than by the worker, so the business it
 * belongs to is derived from the job and cannot be chosen by the caller.
 */
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
  v_source   public.channel_type;
  v_batch    uuid;
  v_result   jsonb;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  -- Only the provider is needed, to pick the channel type. An earlier version
  -- selected the whole account row alongside it, which PL/pgSQL refuses:
  -- a record variable cannot share an INTO list with a scalar (42601).
  select i.provider into v_provider
  from public.integration_accounts a
  join public.integrations i on i.id = a.integration_id
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
    business_id, entity, status, source, file_name, file_type,
    file_size_bytes, row_count
  )
  values (
    v_job.business_id, 'ORDERS', 'DRAFT', v_source,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0)
  )
  returning id into v_batch;

  v_result := public.import_apply_orders(v_batch, p_rows);

  return v_result || jsonb_build_object('batch_id', v_batch);
end;
$$;


/**
 * Applies records carried by a verified webhook.
 *
 * Takes an EVENT id, not a business id: the tenant comes from the stored
 * event, which came from the connection, which an owner created. A webhook is
 * not a privileged shortcut into the data model -- it lands in the same
 * ingestion pipeline as a CSV row.
 */
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

  v_source := case v_event.provider
                when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
                when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
                else 'OTHER'::public.channel_type
              end;

  insert into public.import_batches (
    business_id, entity, status, source, file_name, file_type,
    file_size_bytes, row_count
  )
  values (
    v_event.business_id, 'ORDERS', 'DRAFT', v_source,
    'webhook:' || v_event.event_type, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0)
  )
  returning id into v_batch;

  return public.import_apply_orders(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;


/** Marks a webhook event's processing outcome, with the same backoff shape. */
create or replace function public.webhook_event_complete(
  p_event_id uuid,
  p_status   public.webhook_event_status,
  p_error    text default null
)
returns public.webhook_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.webhook_events;
  v_cap   integer;
begin
  select * into v_event from public.webhook_events where id = p_event_id;
  if v_event.id is null then
    raise exception 'No such webhook event.' using errcode = 'P0002';
  end if;

  if p_status = 'PROCESSED' then
    update public.webhook_events
    set status = 'PROCESSED', processed_at = now(), last_error = null,
        next_run_at = null
    where id = p_event_id
    returning * into v_event;
    return v_event;
  end if;

  if v_event.attempts + 1 >= v_event.max_attempts then
    update public.webhook_events
    set status = 'DEAD_LETTER', attempts = attempts + 1, last_error = p_error,
        next_run_at = null
    where id = p_event_id
    returning * into v_event;

    insert into public.audit_logs
      (business_id, actor_id, action, entity_type, entity_id, after_data)
    values (
      v_event.business_id, null, 'integration.webhook.dead_letter',
      'webhook_events', v_event.id,
      jsonb_build_object('attempts', v_event.attempts, 'error', p_error)
    );

    return v_event;
  end if;

  v_cap := least(30 * (2 ^ least(v_event.attempts, 10))::integer, 28800);

  update public.webhook_events
  set status = 'FAILED',
      attempts = attempts + 1,
      last_error = p_error,
      next_run_at = now() + make_interval(secs => random() * v_cap)
  where id = p_event_id
  returning * into v_event;

  return v_event;
end;
$$;


/** Claims webhook events for processing, with the same locking discipline. */
create or replace function public.webhook_claim_events(p_limit integer default 10)
returns setof public.webhook_events
language sql
security definer
set search_path = ''
as $$
  update public.webhook_events e
  set status = 'PROCESSING'
  where e.id in (
    select c.id
    from public.webhook_events c
    where c.status in ('RECEIVED', 'FAILED')
      and c.signature_valid
      and (c.next_run_at is null or c.next_run_at <= now())
    order by c.received_at
    for update skip locked
    limit p_limit
  )
  returning e.*;
$$;


-- ----------------------------------------------------------------------------
-- 10. The authenticated path
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER, so RLS applies inside them and a caller can only ever act
-- on their own business.

/**
 * Connects or reconnects a store.
 *
 * Idempotent on (business, provider, external account). Reconnecting keeps the
 * same row and the SAME CHANNEL -- which is the whole point. A second channel
 * would split a store's history in two and quietly halve every figure that
 * groups by channel.
 */
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
  v_user      uuid := (select auth.uid());
  v_integration public.integrations;
  v_account   public.integration_accounts;
  v_channel   uuid;
  v_before    jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- SECURITY DEFINER, so this check IS the tenant boundary rather than a
  -- friendlier error in front of one. It validates the caller's role against
  -- the business they named, which a caller who is not a member cannot pass.
  --
  -- Definer is necessary because the function does `returning *`, and that
  -- needs SELECT on every column -- including the two that `authenticated` is
  -- deliberately not granted. The secrets are blanked before returning.
  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can connect an integration.'
      using errcode = '42501';
  end if;

  insert into public.integrations (business_id, provider, created_by)
  values (p_business_id, p_provider, v_user)
  on conflict (business_id, provider) do update
    set status = 'CONNECTED', updated_at = now()
  returning * into v_integration;

  -- The audit "before" snapshot must not carry ciphertext into a table an
  -- admin can read. audit_logs is readable by admins; these columns are not.
  select to_jsonb(a) - 'credentials_encrypted' - 'webhook_secret_encrypted'
    into v_before
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  -- Reuse the existing channel if this store has been connected before.
  select a.channel_id into v_channel
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  if v_channel is null then
    insert into public.channels (business_id, name, type)
    values (p_business_id, coalesce(p_display_name, p_external_account_id), p_channel_type)
    on conflict (business_id, name) do update set is_active = true
    returning id into v_channel;
  end if;

  insert into public.integration_accounts (
    business_id, integration_id, external_account_id, display_name,
    status, channel_id, metadata, connected_by, connected_at, revoked_at
  )
  values (
    p_business_id, v_integration.id, p_external_account_id, p_display_name,
    'CONNECTED', v_channel, coalesce(p_metadata, '{}'::jsonb), v_user, now(), null
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

  -- The return type is the full row, so the sealed secrets would travel back
  -- to the browser on a RECONNECT -- when they already exist. Blanked here.
  -- The caller never needs them: it writes them through the privileged path
  -- and never reads one.
  v_account.credentials_encrypted := null;
  v_account.webhook_secret_encrypted := null;

  return v_account;
end;
$$;


/**
 * Revokes a connection. Business data is kept, deliberately.
 *
 * SECURITY DEFINER, unlike its sibling `integration_account_connect`, for one
 * specific reason: it clears the stored secrets, and `authenticated` is not
 * granted UPDATE on those columns. A caller cannot write them directly, so the
 * clearing has to happen inside a function that can.
 *
 * That means RLS does not filter the lookup below, so the ROLE CHECK is what
 * enforces the tenant boundary here -- and it checks the role against the
 * account's own business, which a foreign caller cannot satisfy.
 */
create or replace function public.integration_account_revoke(p_account_id uuid)
returns public.integration_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.integration_accounts;
begin
  select * into v_account from public.integration_accounts where id = p_account_id;

  if v_account.id is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_account.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can disconnect an integration.'
      using errcode = '42501';
  end if;

  update public.integration_accounts
  set status = 'DISCONNECTED',
      revoked_at = now(),
      credentials_encrypted = null,
      webhook_secret_encrypted = null
  where id = p_account_id
  returning * into v_account;

  update public.sync_jobs
  set status = 'FAILED', last_error = 'Connection revoked.'
  where integration_account_id = p_account_id
    and status in ('QUEUED','RETRYING','RUNNING');

  perform public.write_audit_log(
    v_account.business_id, 'integration.connection.revoked',
    'integration_accounts', v_account.id, null,
    jsonb_build_object('external_account_id', v_account.external_account_id)
  );

  return v_account;
end;
$$;


/** Queues a sync. Idempotent per (account, resource). */
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
  v_account public.integration_accounts;
  v_job     public.sync_jobs;
begin
  select * into v_account from public.integration_accounts where id = p_account_id;

  if v_account.id is null then
    raise exception 'No such integration account.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_account.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can start a sync.'
      using errcode = '42501';
  end if;

  if v_account.status = 'DISCONNECTED' then
    raise exception 'That connection has been disconnected.' using errcode = 'P0001';
  end if;

  insert into public.sync_jobs (
    business_id, integration_account_id, resource, mode, status,
    priority, next_run_at
  )
  values (
    v_account.business_id, p_account_id, p_resource, p_mode, 'QUEUED',
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
    v_account.business_id, 'integration.sync.enqueued', 'sync_jobs', v_job.id,
    null, jsonb_build_object('resource', p_resource, 'mode', p_mode)
  );

  return v_job;
end;
$$;


/** Re-queues a stored delivery. Owner or admin only, and audited. */
create or replace function public.webhook_event_replay(p_event_id uuid)
returns public.webhook_events
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.webhook_events;
begin
  select * into v_event from public.webhook_events where id = p_event_id;

  if v_event.id is null then
    raise exception 'No such webhook event.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_event.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can replay a webhook.'
      using errcode = '42501';
  end if;

  if not v_event.signature_valid then
    raise exception 'That delivery failed signature verification and cannot be replayed.'
      using errcode = 'P0001';
  end if;

  update public.webhook_events
  set status = 'RECEIVED', attempts = 0, next_run_at = now(), last_error = null
  where id = p_event_id
  returning * into v_event;

  perform public.write_audit_log(
    v_event.business_id, 'integration.webhook.replayed', 'webhook_events',
    v_event.id, null, jsonb_build_object('external_event_id', v_event.external_event_id)
  );

  return v_event;
end;
$$;


-- ----------------------------------------------------------------------------
-- 11. Privileges
-- ----------------------------------------------------------------------------

-- Session-less: service_role ONLY. Not anon, not authenticated.
revoke all on function public.webhook_event_ingest(
  public.integration_provider, text, text, text, text, boolean)
  from anon, authenticated, public;
grant execute on function public.webhook_event_ingest(
  public.integration_provider, text, text, text, text, boolean) to service_role;

revoke all on function public.webhook_account_lookup(
  public.integration_provider, text) from anon, authenticated, public;
grant execute on function public.webhook_account_lookup(
  public.integration_provider, text) to service_role;

revoke all on function public.sync_claim_jobs(text, integer, integer)
  from anon, authenticated, public;
grant execute on function public.sync_claim_jobs(text, integer, integer) to service_role;

revoke all on function public.sync_run_start(uuid) from anon, authenticated, public;
grant execute on function public.sync_run_start(uuid) to service_role;

revoke all on function public.sync_job_complete(
  uuid, uuid, public.sync_status, text, integer, integer, integer, text, integer)
  from anon, authenticated, public;
grant execute on function public.sync_job_complete(
  uuid, uuid, public.sync_status, text, integer, integer, integer, text, integer)
  to service_role;

revoke all on function public.webhook_apply_records(uuid, jsonb)
  from anon, authenticated, public;
grant execute on function public.webhook_apply_records(uuid, jsonb) to service_role;

revoke all on function public.sync_job_context(uuid)
  from anon, authenticated, public;
grant execute on function public.sync_job_context(uuid) to service_role;

revoke all on function public.sync_apply_orders(uuid, jsonb)
  from anon, authenticated, public;
grant execute on function public.sync_apply_orders(uuid, jsonb) to service_role;

revoke all on function public.webhook_claim_events(integer)
  from anon, authenticated, public;
grant execute on function public.webhook_claim_events(integer) to service_role;

revoke all on function public.webhook_event_complete(
  uuid, public.webhook_event_status, text) from anon, authenticated, public;
grant execute on function public.webhook_event_complete(
  uuid, public.webhook_event_status, text) to service_role;

-- Authenticated: the owner's own actions.
revoke all on function public.integration_account_connect(
  uuid, public.integration_provider, text, text, public.channel_type, jsonb)
  from anon, public;
grant execute on function public.integration_account_connect(
  uuid, public.integration_provider, text, text, public.channel_type, jsonb)
  to authenticated;

revoke all on function public.integration_account_revoke(uuid) from anon, public;
grant execute on function public.integration_account_revoke(uuid) to authenticated;

revoke all on function public.sync_enqueue(uuid, text, public.sync_mode, smallint)
  from anon, public;
grant execute on function public.sync_enqueue(uuid, text, public.sync_mode, smallint)
  to authenticated;

revoke all on function public.webhook_event_replay(uuid) from anon, public;
grant execute on function public.webhook_event_replay(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 12. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t          text;
  fn         text;
  v_rls      boolean;
  v_policies integer;
begin
  foreach t in array array[
    'integrations', 'integration_accounts', 'sync_jobs',
    'sync_runs', 'sync_logs', 'webhook_events'
  ]
  loop
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = t;

    if v_policies <> 4 then
      raise exception 'SECURITY: table public.% has % policies, expected 4', t, v_policies;
    end if;

    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'SECURITY: anon can read public.%', t;
    end if;
  end loop;

  -- The session-less functions must be unreachable by a signed-in user. If
  -- `authenticated` could call webhook_event_ingest, anyone with a login could
  -- forge a delivery into any business on the platform.
  foreach fn in array array[
    'webhook_event_ingest', 'webhook_account_lookup', 'sync_claim_jobs',
    'sync_run_start', 'sync_job_complete', 'webhook_claim_events',
    'webhook_event_complete', 'sync_job_context', 'sync_apply_orders',
    'webhook_apply_records'
  ]
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception
        'SECURITY: %() is callable without service_role. A signed-in user '
        'could forge integration events.', fn;
    end if;
  end loop;

  -- And the owner's own actions must still work.
  foreach fn in array array[
    'integration_account_connect', 'integration_account_revoke',
    'sync_enqueue', 'webhook_event_replay'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'authenticated cannot execute %()', fn;
    end if;
  end loop;

  -- Credentials must not be readable by a signed-in user.
  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'credentials_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integration_accounts.credentials_encrypted';
  end if;

  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'webhook_secret_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integration_accounts.webhook_secret_encrypted';
  end if;

  -- Writing them is checked too. A user who could overwrite a webhook secret
  -- could set one they know and then forge deliveries that verify.
  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'webhook_secret_encrypted', 'UPDATE') then
    raise exception
      'SECURITY: authenticated can overwrite integration_accounts.webhook_secret_encrypted';
  end if;

  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'credentials_encrypted', 'UPDATE') then
    raise exception
      'SECURITY: authenticated can overwrite integration_accounts.credentials_encrypted';
  end if;

  -- And the ordinary columns must still be readable, or the app is broken in
  -- the other direction.
  if not has_column_privilege(
       'authenticated', 'public.integration_accounts', 'status', 'SELECT') then
    raise exception 'authenticated cannot read integration_accounts.status';
  end if;

  raise notice
    'Migration 0012 verified: RLS on every table, credentials unreadable by '
    'users, session-less functions restricted to service_role.';
end;
$$;


commit;
