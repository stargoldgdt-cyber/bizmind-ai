-- ============================================================================
-- 0040  Report exports to Google Sheets
-- ============================================================================
-- GCC Phase 8, part 2. A catalogue report is copied into a NEW Google Sheet,
-- created by BizMind in the owner's Drive (decision A5: BizMind writes only to
-- spreadsheets it created for an export; never two-way sync).
--
-- WHY A QUEUE
--   The business's Google authorization is sealed and never readable by a
--   signed-in user (0022). So a person only REQUESTS an export; the background
--   worker -- one of the two session-less jobs allowed the worker key (CLAUDE.md
--   section 4) -- claims it, reads the report's figures for that export's own
--   business, creates the spreadsheet, fills it, and records the result.
--
-- WRITE SCOPE
--   * No function takes a spreadsheet id from a person. The worker records the
--     id of the spreadsheet it has just created (report_export_attach), once;
--     it can never be changed or pointed elsewhere.
--   * Every worker function takes an EXPORT id and derives the business from
--     that row, like the sync functions.
--
-- WHAT IS ADDED
--   report_exports                      requests, status, the created sheet
--   report_export_request()             OWNER/ADMIN, audited
--   report_export_claim/data/attach/complete()   service_role only
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0039.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create table public.report_exports (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  report_key      text not null check (report_key in ('marketplace-profit', 'product-profit', 'net-profit', 'payouts', 'data-quality')),
  month_key       text check (month_key is null or month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  destination     text not null default 'GOOGLE_SHEETS' check (destination = 'GOOGLE_SHEETS'),
  requested_by    uuid references public.profiles (id) on delete set null,
  status          text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts        integer not null default 0 check (attempts between 0 and 10),
  lease_until     timestamptz,
  spreadsheet_id  text check (spreadsheet_id is null or spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
  spreadsheet_url text check (spreadsheet_url is null or spreadsheet_url like 'https://docs.google.com/spreadsheets/d/%'),
  error           text check (error is null or length(error) <= 500),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  constraint report_exports_success_check check (status <> 'SUCCEEDED' or spreadsheet_id is not null)
);

comment on table public.report_exports is
  'A request to copy a catalogue report into a new Google Sheet, and the sheet '
  'BizMind created for it. BizMind writes only to spreadsheets recorded here.';

create unique index report_exports_spreadsheet_key on public.report_exports (spreadsheet_id)
  where spreadsheet_id is not null;
create index report_exports_business_idx on public.report_exports (business_id, created_at desc);
create index report_exports_queue_idx on public.report_exports (status, created_at)
  where status in ('QUEUED', 'RUNNING');

/** The sheet an export created is recorded once and never repointed. */
create function public.report_export_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.spreadsheet_id is not null and new.spreadsheet_id is distinct from old.spreadsheet_id then
    raise exception 'An export''s spreadsheet cannot be changed.' using errcode = '42501';
  end if;
  if (new.business_id, new.report_key, new.month_key, new.destination, new.created_at)
     is distinct from (old.business_id, old.report_key, old.month_key, old.destination, old.created_at) then
    raise exception 'An export request cannot be edited.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger report_exports_guard
  before update on public.report_exports
  for each row execute function public.report_export_guard();

alter table public.report_exports enable row level security;
alter table public.report_exports force row level security;

create policy report_exports_select_member on public.report_exports
  for select to authenticated
  using (business_id in (select public.current_user_business_ids()));

revoke all on table public.report_exports from anon, authenticated, public;
grant select on table public.report_exports to authenticated;


-- ----------------------------------------------------------------------------
-- A person asks
-- ----------------------------------------------------------------------------

create function public.report_export_request(
  p_business_id uuid,
  p_report_key  text,
  p_month_key   text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can export to Google Sheets.' using errcode = '42501';
  end if;
  if p_report_key is null
     or p_report_key not in ('marketplace-profit', 'product-profit', 'net-profit', 'payouts', 'data-quality') then
    raise exception 'That report does not exist.' using errcode = '22023';
  end if;
  if p_report_key in ('marketplace-profit', 'product-profit', 'net-profit')
     and coalesce(p_month_key, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a month for this report.' using errcode = '22023';
  end if;
  if p_month_key is not null and p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'That month could not be read.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.integrations i
    where i.business_id = p_business_id and i.provider = 'GOOGLE_SHEETS' and i.authorized_at is not null
  ) then
    raise exception 'Connect Google first, under Integrations.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.report_exports e
      where e.business_id = p_business_id and e.status in ('QUEUED', 'RUNNING')) >= 3 then
    raise exception 'Three exports are already on their way. Wait for them to finish.' using errcode = 'P0001';
  end if;

  insert into public.report_exports (business_id, report_key, month_key, requested_by)
  values (p_business_id, p_report_key,
          case when p_report_key = 'data-quality' then null else p_month_key end,
          (select auth.uid()))
  returning id into v_id;

  perform public.write_audit_log(
    p_business_id, 'report.export_requested', 'report_exports', v_id, null,
    jsonb_build_object('report_key', p_report_key, 'month_key', p_month_key, 'destination', 'GOOGLE_SHEETS')
  );
  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- The worker (service_role only). Each takes an export id, never a business id.
-- ----------------------------------------------------------------------------

/**
 * Claims up to p_limit exports. A RUNNING export whose lease ran out is tried
 * again, at most three times in all; after that it FAILED.
 */
create function public.report_export_claim(p_worker_id text, p_limit integer default 3)
returns table (
  export_id             uuid,
  business_id           uuid,
  business_name         text,
  report_key            text,
  month_key             text,
  credentials_encrypted text,
  attempts              integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(length(p_worker_id), 0) not between 1 and 200 then
    raise exception 'A worker id is required.' using errcode = '22023';
  end if;

  update public.report_exports e
  set status = 'FAILED', finished_at = now(), lease_until = null,
      error = coalesce(e.error, 'The export did not finish after three attempts.')
  where e.status = 'RUNNING' and e.lease_until < now() and e.attempts >= 3;

  return query
  with picked as (
    select e.id
    from public.report_exports e
    where e.status = 'QUEUED'
       or (e.status = 'RUNNING' and e.lease_until < now() and e.attempts < 3)
    order by e.created_at
    limit greatest(1, least(coalesce(p_limit, 3), 20))
    for update skip locked
  ),
  claimed as (
    update public.report_exports e
    set status = 'RUNNING', attempts = e.attempts + 1, started_at = now(),
        lease_until = now() + interval '5 minutes', error = null
    from picked
    where e.id = picked.id
    returning e.id, e.business_id, e.report_key, e.month_key, e.attempts
  )
  select c.id, c.business_id, b.name::text, c.report_key, c.month_key, i.credentials_encrypted, c.attempts
  from claimed c
  join public.businesses b on b.id = c.business_id
  left join public.integrations i on i.business_id = c.business_id and i.provider = 'GOOGLE_SHEETS';
end;
$$;

/** Every figure the export's report needs, for that export's own business. */
create function public.report_export_data(p_export_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export public.report_exports;
  v_from   timestamptz;
  v_to     timestamptz;
  v_biz    uuid;
begin
  select * into v_export from public.report_exports e where e.id = p_export_id;
  if v_export.id is null or v_export.status <> 'RUNNING' then
    raise exception 'That export is not running.' using errcode = 'P0002';
  end if;
  v_biz := v_export.business_id;
  if v_export.month_key is not null then
    v_from := (v_export.month_key || '-01T00:00:00Z')::timestamptz;
    v_to := v_from + interval '1 month';
  end if;

  return jsonb_build_object(
    'business_name', (select b.name from public.businesses b where b.id = v_biz),
    'report_key', v_export.report_key,
    'month_key', v_export.month_key,
    'data',
    case v_export.report_key
      when 'marketplace-profit' then jsonb_build_object(
        'perAccount', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.pnl_summary(v_from, v_to, null, v_biz, false) s),
        'perCurrency', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from public.pnl_summary(v_from, v_to, null, v_biz, true) s))
      when 'product-profit' then jsonb_build_object(
        'products', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from public.pnl_by_product(v_from, v_to, null, v_biz) p))
      when 'net-profit' then jsonb_build_object(
        'net', (select coalesce(jsonb_agg(to_jsonb(n)), '[]') from public.pnl_net_profit(v_from, v_to, v_biz) n),
        'expenses', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.expense_breakdown(v_from, v_to, v_biz) x))
      when 'payouts' then jsonb_build_object(
        'payouts', (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from public.expected_payouts(v_biz, v_from, v_to, null) p),
        'cashflow', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from public.expected_cashflow(v_biz, null, null) c))
      else jsonb_build_object(
        'quality', (select coalesce(jsonb_agg(to_jsonb(q)), '[]') from public.ledger_data_quality(p_business_id => v_biz) q))
    end
  );
end;
$$;

/** Records the spreadsheet the worker has just created. Once. */
create function public.report_export_attach(p_export_id uuid, p_spreadsheet_id text, p_spreadsheet_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export public.report_exports;
begin
  select * into v_export from public.report_exports e where e.id = p_export_id for update;
  if v_export.id is null or v_export.status <> 'RUNNING' then
    raise exception 'That export is not running.' using errcode = 'P0002';
  end if;
  if v_export.spreadsheet_id is not null then
    raise exception 'This export already has its spreadsheet.' using errcode = '42501';
  end if;
  if p_spreadsheet_url is distinct from 'https://docs.google.com/spreadsheets/d/' || p_spreadsheet_id || '/edit' then
    raise exception 'The spreadsheet link must be the created spreadsheet''s own.' using errcode = '22023';
  end if;

  update public.report_exports
  set spreadsheet_id = p_spreadsheet_id, spreadsheet_url = p_spreadsheet_url
  where id = p_export_id;
end;
$$;

/** Finishes a claimed export: SUCCEEDED, FAILED, or RETRY (queued again while attempts remain). */
create function public.report_export_complete(p_export_id uuid, p_status text, p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_export public.report_exports;
  v_status text;
begin
  select * into v_export from public.report_exports e where e.id = p_export_id for update;
  if v_export.id is null or v_export.status <> 'RUNNING' then
    raise exception 'That export is not running.' using errcode = 'P0002';
  end if;
  if p_status not in ('SUCCEEDED', 'FAILED', 'RETRY') then
    raise exception 'Unknown outcome.' using errcode = '22023';
  end if;
  if p_status = 'SUCCEEDED' and v_export.spreadsheet_id is null then
    raise exception 'An export succeeds only with the spreadsheet it created.' using errcode = '22023';
  end if;

  v_status := case
    -- A retry never creates a second spreadsheet: once one exists, the export ends.
    when p_status = 'RETRY' and v_export.attempts < 3 and v_export.spreadsheet_id is null then 'QUEUED'
    when p_status = 'RETRY' then 'FAILED'
    else p_status
  end;

  update public.report_exports
  set status = v_status,
      lease_until = null,
      finished_at = case when v_status = 'QUEUED' then null else now() end,
      error = case when v_status = 'SUCCEEDED' then null else left(coalesce(p_error, 'The export could not be completed.'), 500) end
  where id = p_export_id;

  if v_status = 'SUCCEEDED' then
    insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
    values (v_export.business_id, null, 'report.exported_to_sheets', 'report_exports', v_export.id, null,
            jsonb_build_object('report_key', v_export.report_key, 'month_key', v_export.month_key,
                               'spreadsheet_id', v_export.spreadsheet_id));
  end if;
  return v_status;
end;
$$;


-- ----------------------------------------------------------------------------
-- Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  revoke all on function public.report_export_request(uuid, text, text) from anon, public;
  grant execute on function public.report_export_request(uuid, text, text) to authenticated;

  foreach f in array array[
    'public.report_export_claim(text, integer)',
    'public.report_export_data(uuid)',
    'public.report_export_attach(uuid, text, text)',
    'public.report_export_complete(uuid, text, text)'
  ]
  loop
    execute format('revoke all on function %s from anon, authenticated, public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  revoke all on function public.report_export_guard() from anon, authenticated, public;
end;
$$;

do $$
declare
  f text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'report_exports' and c.relrowsecurity and c.relforcerowsecurity
  ) or has_table_privilege('authenticated', 'public.report_exports', 'INSERT')
    or has_table_privilege('authenticated', 'public.report_exports', 'UPDATE')
    or has_table_privilege('anon', 'public.report_exports', 'SELECT') then
    raise exception 'SECURITY: report_exports must be RLS-forced, read-only for members, closed to anon.';
  end if;

  foreach f in array array['report_export_claim', 'report_export_data', 'report_export_attach', 'report_export_complete']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be callable by the worker only.', f;
    end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and 'p_business_id' = any(coalesce(p.proargnames, '{}'))
    ) then
      raise exception 'SECURITY: %() must not take a business id.', f;
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'report_export_request'
      and position('spreadsheet' in coalesce(array_to_string(p.proargnames, ','), '')) > 0
  ) then
    raise exception 'SECURITY: a person must never be able to name a spreadsheet to write to.';
  end if;

  raise notice 'Migration 0040 verified: exports queued by owners/admins, written only by the worker, to sheets it created.';
end;
$$;

commit;
