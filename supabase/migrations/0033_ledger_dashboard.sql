-- ============================================================================
-- 0033  The ledger dashboard's readers
-- ============================================================================
-- GCC Phase 4. Three read-only functions for the live dashboard and the
-- validation view. Nothing is written; ledger rows are untouched.
--
--   1. pnl_periods(business)            the months each account has lines in
--   2. pnl_settlements(from, to, acct)  each settlement touching the period:
--                                       the marketplace's reported total, the
--                                       sum of all its lines, the part posted
--                                       in the period, and the reported payout
--   3. ledger_data_quality(...)         recreated with a business filter and
--                                       the marketplace code on every issue
--
-- All three run with the caller's rights (RLS decides what they see).
-- Depends on 0032. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The months with data
-- ----------------------------------------------------------------------------

create function public.pnl_periods(p_business_id uuid default null)
returns table (
  marketplace_account_id uuid,
  account_label          text,
  marketplace_code       text,
  currency               char(3),
  month                  date,
  lines                  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    ft.marketplace_account_id,
    a.label,
    a.marketplace_code,
    ft.currency::char(3),
    (date_trunc('month', ft.posted_at at time zone 'UTC'))::date,
    count(*)
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where p_business_id is null or ft.business_id = p_business_id
  group by 1, 2, 3, 4, 5
  order by 2, 5 desc;
$$;


-- ----------------------------------------------------------------------------
-- 2. What the marketplace reported, beside BizMind's lines
-- ----------------------------------------------------------------------------
-- A settlement often spans two months. It is listed when any of its lines is
-- posted in the period, or its own period overlaps it. lines_total covers the
-- whole settlement (that is what the marketplace's total is compared with);
-- lines_in_period is the part that counts in this period's figures.

create function public.pnl_settlements(
  p_from       timestamptz,
  p_to         timestamptz,
  p_account_id uuid
)
returns table (
  settlement_id          uuid,
  source_file_id         uuid,
  file_name              text,
  external_settlement_id text,
  period_start           timestamptz,
  period_end             timestamptz,
  currency               char(3),
  reported_total         text,
  lines_total            text,
  lines_in_period        text,
  lines_in_period_count  bigint,
  reconciles             boolean,
  payout_amount          text,
  payout_date            timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    st.id,
    st.source_file_id,
    b.file_name,
    st.external_settlement_id,
    st.period_start,
    st.period_end,
    st.currency::char(3),
    st.reported_total::text,
    coalesce(sum(ft.amount), 0)::numeric(20,4)::text,
    coalesce(sum(ft.amount) filter (where ft.posted_at >= p_from and ft.posted_at < p_to), 0)::numeric(20,4)::text,
    count(ft.id) filter (where ft.posted_at >= p_from and ft.posted_at < p_to),
    st.reported_total is not null and st.reported_total = coalesce(sum(ft.amount), 0),
    (select po.amount::text from public.payouts po
      where po.settlement_id = st.id and po.voided_at is null
      order by po.created_at limit 1),
    (select po.paid_at from public.payouts po
      where po.settlement_id = st.id and po.voided_at is null
      order by po.created_at limit 1)
  from public.settlements st
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  left join public.financial_transactions ft on ft.settlement_id = st.id
  where st.marketplace_account_id = p_account_id
  group by st.id, st.source_file_id, b.file_name, st.external_settlement_id,
           st.period_start, st.period_end, st.currency, st.reported_total
  having count(ft.id) filter (where ft.posted_at >= p_from and ft.posted_at < p_to) > 0
      or (st.period_start < p_to and coalesce(st.period_end, st.period_start) >= p_from)
  order by st.period_start nulls last, st.external_settlement_id;
$$;


-- ----------------------------------------------------------------------------
-- 3. Data quality, for one business, with the marketplace on every issue
-- ----------------------------------------------------------------------------
-- The signature changes, so the 0032 function is replaced. Calls that pass
-- only p_from / p_to / p_account_id keep working.

drop function public.ledger_data_quality(timestamptz, timestamptz, uuid);

create function public.ledger_data_quality(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  issue_kind             text,
  severity               text,
  marketplace_account_id uuid,
  account_label          text,
  marketplace_code       text,
  currency               char(3),
  format_id              text,
  reference              text,
  category               text,
  subcategory            text,
  lines                  bigint,
  amount                 text,
  files                  bigint,
  detail                 text
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*
  from public.ledger_classified_lines l
  where (p_from is null or l.posted_at >= p_from)
    and (p_to is null or l.posted_at < p_to)
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
scoped_files as (
  select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
  from scoped s
),
issues as (
  select
    'UNKNOWN_CODE'::text                                 as issue_kind,
    'WARNING'::text                                      as severity,
    s.marketplace_account_id                             as marketplace_account_id,
    s.account_label                                      as account_label,
    s.marketplace_code                                   as marketplace_code,
    s.currency::char(3)                                  as currency,
    s.format_id                                          as format_id,
    s.match_key                                          as reference,
    null::text                                           as category,
    null::text                                           as subcategory,
    count(*)                                             as lines,
    sum(s.amount::numeric(20,4))::numeric(20,4)::text    as amount,
    count(distinct s.source_file_id)                     as files,
    'Not classified yet. Kept with its amount; counts towards no figure, and the figures it could affect are incomplete.'::text as detail
  from scoped s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

  union all

  select
    'UNDER_REVIEW', 'INFO', s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency::char(3),
    s.format_id, s.match_key, s.category, s.subcategory,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'Counted using a medium-confidence rule. Check it against the marketplace report.'
  from scoped s
  where s.classification_status = 'UNDER_REVIEW'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id,
           s.match_key, s.category, s.subcategory

  union all

  select
    'VAT_TREATMENT_UNKNOWN', 'WARNING', s.marketplace_account_id, s.account_label, s.marketplace_code,
    s.currency::char(3), null, null, 'INPUT_VAT', null,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'The VAT setting for this account is Unknown, so contribution is incomplete. Set it once your accountant confirms whether this VAT is recoverable.'
  from scoped s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

  union all

  select
    'ROW_ERRORS', 'WARNING', f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency::char(3),
    null, null, null, null,
    count(*), null, count(distinct f.source_file_id),
    'Rows in these files could not be read, so the figures they belong to are incomplete.'
  from scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

  union all

  select
    'SETTLEMENT_MISMATCH', 'WARNING', st.marketplace_account_id, a.label, a.marketplace_code, st.currency::char(3),
    null, st.external_settlement_id, null, null,
    count(ft.id), (st.reported_total - coalesce(sum(ft.amount), 0))::numeric(20,4)::text, 1::bigint,
    'The total the marketplace reported differs from the sum of its lines by this amount.'
  from public.settlements st
  join (select distinct sf.source_file_id from scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
           st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
)
select * from issues
order by severity desc, issue_kind, account_label, reference;
$$;


-- ----------------------------------------------------------------------------
-- 4. Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.pnl_periods(uuid)',
    'public.pnl_settlements(timestamptz, timestamptz, uuid)',
    'public.ledger_data_quality(timestamptz, timestamptz, uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['pnl_periods', 'pnl_settlements', 'ledger_data_quality']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
  end loop;

  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'ledger_data_quality') <> 1 then
    raise exception 'Exactly one ledger_data_quality() must exist.';
  end if;

  raise notice 'Migration 0033 verified: three invoker readers, closed to anon.';
end;
$$;


commit;
