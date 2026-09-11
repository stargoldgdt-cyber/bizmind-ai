-- ============================================================================
-- 0023  Applying a spreadsheet's rows
-- ============================================================================
-- Step 3 of the Google Sheets connection. The worker now applies a sheet's
-- rows through the SAME validation and apply functions an Excel upload uses.
-- This gives it the four things it needs from the database:
--
--   1. The business's currency, from sync_job_context(), so a row in another
--      currency is refused exactly as an upload refuses it.
--
--   2. Read-throughs ("passes") told apart by an ID, not a clock. Record state
--      now remembers WHICH PASS last saw each record. That answers two
--      questions without the application's clock and the database's clock
--      having to agree:
--        - "seen earlier in this same pass, somewhere else in the sheet?" --
--          an order whose rows are split between two parts of the sheet read
--          separately. Writing the second part would REPLACE the first part's
--          lines, so the worker refuses it and says why.
--        - "not seen at all in the pass that just finished?" -- gone from the
--          sheet. Marked, never deleted, as before.
--
--   3. sync_record_issues(): a sync page's row problems go into import_issues,
--      where an upload's problems already go, tied to the batch that page
--      wrote -- or to a batch of its own when every changed row was refused.
--
--   4. A FIX to sync_job_complete(). Since 0012 it has ignored a DEAD_LETTER
--      status from the worker and retried anyway: up to seven attempts, over
--      several hours, for failures retrying cannot fix -- a deleted sheet, a
--      revoked store key. The worker's own comment says it goes "straight to
--      the state a person can see". Now it does.
--
-- Depends on 0020-0022. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. sync_job_context(): + the business's currency
-- ----------------------------------------------------------------------------
-- A new result column is a return-type change, which CREATE OR REPLACE refuses
-- (42P13). So it is dropped and created again; its privileges are re-issued in
-- section 6.

drop function public.sync_job_context(uuid);

create function public.sync_job_context(p_job_id uuid)
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
  account_status    public.integration_status,
  business_currency text
)
language sql
security definer
set search_path = ''
as $$
  select
    j.id, j.business_id, a.id, i.provider, a.external_account_id,
    coalesce(a.credentials_encrypted, i.credentials_encrypted),
    a.metadata, j.resource, j.mode, j.cursor, a.status,
    b.currency::text
  from public.sync_jobs j
  join public.integration_accounts a on a.id = j.integration_account_id
  join public.integrations i on i.id = a.integration_id
  join public.businesses b on b.id = j.business_id
  where j.id = p_job_id;
$$;


-- ----------------------------------------------------------------------------
-- 2. Record state remembers the pass that last saw each record
-- ----------------------------------------------------------------------------

alter table public.integration_record_state
  add column last_seen_pass text;

comment on column public.integration_record_state.last_seen_pass is
  'The read-through that last saw this record: an opaque id from the '
  'connector''s cursor. Compared for equality only -- never as a time.';


-- Each of the three functions gains a trailing parameter with a default, so
-- every existing call still works. The old signatures are dropped first:
-- two overloads would make every call by name ambiguous.

drop function public.sync_record_state_classify(uuid, jsonb);

/**
 * Which records on this page are new, changed, unchanged -- and which were
 * already seen EARLIER IN THIS PASS at a different place in the sheet.
 *
 * Read-only. p_items: [{ "key", "hash", "locator": { "rows": [...] } }, ...]
 *
 * The same page read twice (a retry) has the same locator, so it is not
 * reported as repeated.
 */
create function public.sync_record_state_classify(
  p_job_id  uuid,
  p_items   jsonb,
  p_pass_id text default null
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
        e.item ->> 'hash' as h,
        coalesce(e.item -> 'locator', '{}'::jsonb) as l
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
      where nullif(e.item ->> 'key', '') is not null
    ),
    joined as (
      select it.k, it.h, it.l,
             s.content_hash, s.last_seen_pass, s.locator as seen_at
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
        count(*) filter (where j.content_hash = j.h),
      'repeated',
        coalesce(jsonb_agg(j.k) filter (
          where p_pass_id is not null
            and j.last_seen_pass = p_pass_id
            and j.seen_at is distinct from j.l
        ), '[]'::jsonb)
    )
    from joined j
  );
end;
$$;


drop function public.sync_record_state_commit(uuid, uuid, jsonb);

/**
 * Records what was seen on this page, AFTER it was applied -- now including
 * the pass that saw it.
 *
 * p_items: [{ "key", "hash", "outcome": "APPLIED"|"REJECTED"|null, "locator": {} }]
 * An item with no outcome was unchanged: its last outcome is kept and only
 * last_seen moves, which is what missing-record detection relies on.
 */
create function public.sync_record_state_commit(
  p_job_id  uuid,
  p_run_id  uuid,
  p_items   jsonb,
  p_pass_id text default null
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
    last_changed_at, last_seen_run_id, last_seen_pass
  )
  select
    v_job.business_id, v_job.integration_account_id, v_job.resource,
    d.item ->> 'key',
    d.item ->> 'hash',
    -- A brand-new record must say how it went. Defaulting to APPLIED would
    -- report a rejected row as imported.
    coalesce(nullif(d.item ->> 'outcome', ''), 'REJECTED'),
    coalesce(d.item -> 'locator', '{}'::jsonb),
    true, now(), now(), now(), p_run_id, p_pass_id
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
    last_seen_run_id = excluded.last_seen_run_id,
    last_seen_pass   = excluded.last_seen_pass;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


drop function public.sync_record_state_mark_missing(uuid, timestamptz);

/**
 * After a COMPLETE pass: marks records that pass did not see as no longer
 * present, and returns how many are missing in total.
 *
 * Given a pass id, "not seen" means "not seen by that pass" -- no clock
 * involved. The older form, a start time, still works for callers without one.
 *
 * Marks, never deletes. The count is what an owner is shown.
 */
create function public.sync_record_state_mark_missing(
  p_job_id          uuid,
  p_pass_started_at timestamptz default null,
  p_pass_id         text default null
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

  if p_pass_id is null and p_pass_started_at is null then
    raise exception 'Say which pass has just finished.' using errcode = '22023';
  end if;

  update public.integration_record_state
  set present = false
  where integration_account_id = v_job.integration_account_id
    and entity = v_job.resource
    and present
    and case
          when p_pass_id is not null then last_seen_pass is distinct from p_pass_id
          else last_seen_at < p_pass_started_at
        end;

  select count(*) into v_missing
  from public.integration_record_state
  where integration_account_id = v_job.integration_account_id
    and entity = v_job.resource
    and not present;

  return v_missing;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. sync_record_issues(): a sync page's row problems, where an upload's go
-- ----------------------------------------------------------------------------

/**
 * Records the problems found on one sync page in import_issues.
 *
 * Takes a JOB id and derives the business from it, like every function the
 * worker calls. A batch id, when given, must be one THIS connection wrote --
 * so a job id cannot be used to hang problems on another import, let alone
 * another business's.
 *
 * With no batch -- every changed row on the page was refused, so nothing was
 * written and no batch exists -- it creates one, marked FAILED, so the
 * problems still have somewhere to live and the owner can see them.
 *
 * p_issues: [{ "row_number", "severity": "ERROR"|"WARNING", "field",
 *              "message", "raw_value" }], at most 500 kept.
 */
create function public.sync_record_issues(
  p_job_id      uuid,
  p_batch_id    uuid,
  p_issues      jsonb,
  p_rows_valid  integer default null,
  p_rows_failed integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.sync_jobs;
  v_batch   public.import_batches;
  v_channel uuid;
  v_type    public.channel_type;
  v_run     uuid;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  if v_job.resource not in ('ORDERS', 'PRODUCTS', 'EXPENSES') then
    raise exception 'Row problems are recorded only for orders, products and expenses.'
      using errcode = 'P0001';
  end if;

  if p_batch_id is not null then
    select * into v_batch from public.import_batches where id = p_batch_id;

    if v_batch.id is null
       or v_batch.business_id <> v_job.business_id
       or v_batch.integration_account_id is distinct from v_job.integration_account_id then
      raise exception 'That import batch does not belong to this sync.'
        using errcode = '42501';
    end if;
  else
    select a.channel_id into v_channel
    from public.integration_accounts a
    where a.id = v_job.integration_account_id;

    if v_channel is not null then
      select c.type into v_type from public.channels c where c.id = v_channel;
    end if;

    select r.id into v_run
    from public.sync_runs r
    where r.job_id = p_job_id and r.status = 'RUNNING'
    order by r.started_at desc
    limit 1;

    insert into public.import_batches (
      business_id, entity, status, source, channel_id, file_name, file_type,
      file_size_bytes, row_count, integration_account_id, sync_run_id,
      created_count, updated_count, error, committed_at
    )
    values (
      v_job.business_id, v_job.resource::public.import_entity, 'FAILED',
      coalesce(v_type, 'OTHER'::public.channel_type),
      case when v_job.resource = 'ORDERS' then v_channel end,
      'sync:' || v_job.resource, 'api', 0, 0,
      v_job.integration_account_id, v_run,
      0, 0,
      'None of the changed rows on this page could be imported. The problems are listed.',
      now()
    )
    returning * into v_batch;
  end if;

  update public.import_batches
  set rows_valid  = coalesce(p_rows_valid, rows_valid),
      rows_failed = coalesce(p_rows_failed, rows_failed)
  where id = v_batch.id;

  insert into public.import_issues (
    business_id, batch_id, row_number, severity, field, message, raw_value
  )
  select
    v_job.business_id,
    v_batch.id,
    coalesce((e.item ->> 'row_number')::integer, 0),
    case when e.item ->> 'severity' = 'WARNING' then 'WARNING' else 'ERROR' end,
    left(nullif(e.item ->> 'field', ''), 64),
    left(coalesce(nullif(e.item ->> 'message', ''), 'This row could not be imported.'), 1000),
    left(e.item ->> 'raw_value', 200)
  from jsonb_array_elements(coalesce(p_issues, '[]'::jsonb)) with ordinality as e(item, n)
  where e.n <= 500;

  return v_batch.id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. sync_job_complete(): a DEAD_LETTER from the worker is honoured
-- ----------------------------------------------------------------------------
-- Identical to 0020 except for one condition, marked below. Same signature, so
-- it is replaced in place and keeps its privileges.

create or replace function public.sync_job_complete(
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

  -- THE ONE CHANGE (0023): the worker's DEAD_LETTER is final. It sends one
  -- only for a failure retrying cannot fix, and before this every such job
  -- was retried until its attempts ran out.
  if p_status = 'DEAD_LETTER' or v_job.attempts >= v_job.max_attempts then
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
-- 5. (No new tables.) integration_record_state keeps its RLS and grants.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 6. Function privileges
-- ----------------------------------------------------------------------------
-- Session-less, service_role only. Supabase's default privileges grant EXECUTE
-- on every new function to anon and authenticated, so it is revoked explicitly.

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.sync_job_context(uuid)',
    'public.sync_record_state_classify(uuid, jsonb, text)',
    'public.sync_record_state_commit(uuid, uuid, jsonb, text)',
    'public.sync_record_state_mark_missing(uuid, timestamptz, text)',
    'public.sync_record_issues(uuid, uuid, jsonb, integer, integer)'
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
  v_fn    text;
  v_count integer;
begin
  foreach v_fn in array array[
    'sync_job_context', 'sync_record_state_classify', 'sync_record_state_commit',
    'sync_record_state_mark_missing', 'sync_record_issues', 'sync_job_complete'
  ]
  loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    -- Two overloads would make every call by name ambiguous.
    if v_count <> 1 then
      raise exception '%() exists % times; expected exactly once.', v_fn, v_count;
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

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_job_context'
      and pg_get_function_result(p.oid) like '%business_currency%'
  ) then
    raise exception 'sync_job_context() does not return the business currency.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_job_complete'
      and p.prosrc like '%p_status = ''DEAD_LETTER'' or%'
  ) then
    raise exception 'sync_job_complete() still ignores a DEAD_LETTER from the worker.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'integration_record_state'
      and column_name = 'last_seen_pass'
  ) then
    raise exception 'integration_record_state.last_seen_pass is missing.';
  end if;

  if has_table_privilege('authenticated', 'public.integration_record_state', 'UPDATE')
     or has_table_privilege('authenticated', 'public.integration_record_state', 'INSERT') then
    raise exception 'SECURITY: a signed-in user can write to integration_record_state.';
  end if;

  raise notice
    'Migration 0023 verified: the worker receives the business currency, record '
    'state tracks passes by id, sync row problems are recorded per connection, '
    'a DEAD_LETTER is final, and every function is service_role only.';
end;
$$;


commit;
