-- ============================================================================
-- 0083  dashboard_accounts(): the quality checks read the distinct line groups once
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- dashboard_accounts() takes the body proven in 0082 (dashboard_accounts_next): its five
-- quality checks read the few hundred distinct line combinations once, instead of a
-- temporary copy of every line with all its columns. Compared for every month and for long
-- ranges in both currencies: 0 differing rows in any column; about 15-25% faster
-- (January-August 5.4-6.2 s -> 4.6 s). Same name, same inputs, same columns and order,
-- SECURITY INVOKER, same grants. Nothing else is touched; the temporary measuring helpers
-- are removed in the next step (0084), after this change is verified against the figures
-- saved before it.
--
-- UNDO: supabase/rollbacks/0083_revert.sql (puts the 0067 body back exactly).
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.dashboard_accounts(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  marketplace_account_id  uuid,
  account_label           text,
  marketplace_code        text,
  has_lines               boolean,
  gross_sales             text,
  sales_refunds           text,
  net_sales               text,
  marketplace_costs       text,
  advertising             text,
  contribution            text,
  contribution_status     text,
  contribution_before_open_items text,
  contribution_margin_pct numeric,
  expected_inflow         text,
  expected_payouts        bigint,
  open_quality_items      bigint,
  share_of_net_sales_pct  numeric,
  costs_pct_of_net_sales  numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with accounts as (
  select a.id, a.label, a.marketplace_code
  from public.marketplace_accounts a
  where a.business_id = p_business_id and a.currency = p_currency
),
types as (
  select * from public.dashboard_line_types(p_business_id, p_currency, p_from, p_to, null)
),
errors as (
  select distinct f.marketplace_account_id
  from (select t.marketplace_account_id, unnest(t.files) as file_id from types t) f
  where exists (select 1 from public.import_issues i where i.batch_id = f.file_id and i.severity = 'ERROR')
),
figures as (
  select
    t.marketplace_account_id,
    coalesce(sum(t.amount) filter (where t.metric_group = 'GROSS_SALES'), 0)                       as gross,
    coalesce(sum(t.amount) filter (where t.metric_group = 'SALES_REFUNDS'), 0)                     as refunds,
    coalesce(sum(t.amount) filter (where t.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net,
    coalesce(sum(t.amount) filter (where t.metric_group in ('MARKETPLACE_FEES', 'FULFILLMENT', 'ADVERTISING', 'OTHER_MARKETPLACE_COSTS')
                                     or (t.metric_group = 'INPUT_VAT' and t.pnl_treatment = 'INCREASE_EXPENSE')), 0) as costs,
    coalesce(sum(t.amount) filter (where t.metric_group = 'ADVERTISING'), 0)                       as ads,
    coalesce(sum(t.amount) filter (where t.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0) as known,
    (bool_or(t.rule_id is null)
      or bool_or(t.pnl_treatment = 'CONDITIONAL')
      or (bool_or(t.rule_includes_vat) and not bool_or(t.rule_separates_vat) and min(t.vat_setting) <> 'NON_RECOVERABLE')
      or bool_or(e.marketplace_account_id is not null))                                            as incomplete
  from types t
  left join errors e on e.marketplace_account_id = t.marketplace_account_id
  group by t.marketplace_account_id
),
payouts as (
  select e.marketplace_account_id, count(*) as n, sum(e.expected_amount::numeric) as inflow
  from public.expected_payouts(p_business_id, p_from, p_to, null) e
  where e.currency = p_currency
  group by 1
),
-- 0067: inline instead of a nested ledger_data_quality() call -- see 0067's
-- header for the measured cost of calling it as a function. Same rules
-- (UNDER_REVIEW excluded, exactly as the old call's own filter excluded it),
-- copied verbatim from 0066.
quality_groups as materialized (
  select
    l.marketplace_account_id, l.account_label, l.marketplace_code, l.currency,
    l.source_file_id, l.format_id, l.match_key,
    l.classification_status, l.pnl_treatment, l.rule_includes_vat, l.rule_separates_vat,
    date_trunc('month', l.posted_at at time zone 'UTC') as posted_month
  from public.ledger_classified_lines l
  where l.posted_at >= p_from and l.posted_at < p_to
    and l.business_id = p_business_id
  group by l.marketplace_account_id, l.account_label, l.marketplace_code, l.currency,
           l.source_file_id, l.format_id, l.match_key,
           l.classification_status, l.pnl_treatment, l.rule_includes_vat, l.rule_separates_vat,
           date_trunc('month', l.posted_at at time zone 'UTC')
),
quality_scoped_files as materialized (
  select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
  from quality_groups s
),
quality_issues as (
  select s.marketplace_account_id, s.currency::char(3) as currency
  from quality_groups s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

  union all

  select s.marketplace_account_id, s.currency::char(3)
  from quality_groups s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

  union all

  select s.marketplace_account_id, s.currency::char(3)
  from quality_groups s
  left join public.tax_profiles tp on tp.marketplace_account_id = s.marketplace_account_id
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency,
           s.posted_month, tp.input_vat_treatment
  having bool_or(s.rule_includes_vat)
     and not bool_or(s.rule_separates_vat)
     and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE'

  union all

  select f.marketplace_account_id, f.currency::char(3)
  from quality_scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

  union all

  select st.marketplace_account_id, st.currency::char(3)
  from public.settlements st
  join (select distinct sf.source_file_id from quality_scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
           st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
),
quality as (
  select q.marketplace_account_id, count(*) as n
  from quality_issues q
  where q.currency = p_currency
  group by 1
),
total as (
  select sum(f.net) as net from figures f
)
select
  a.id,
  a.label,
  a.marketplace_code,
  f.marketplace_account_id is not null,
  f.gross::numeric(20,4)::text,
  f.refunds::numeric(20,4)::text,
  f.net::numeric(20,4)::text,
  f.costs::numeric(20,4)::text,
  f.ads::numeric(20,4)::text,
  case when f.incomplete then null else f.known::numeric(20,4)::text end,
  case when f.marketplace_account_id is null or f.incomplete then 'INCOMPLETE' else 'FINAL' end,
  f.known::numeric(20,4)::text,
  case when f.incomplete then null else public.dashboard_pct(f.known, f.net) end,
  p.inflow::numeric(20,4)::text,
  coalesce(p.n, 0),
  coalesce(q.n, 0),
  public.dashboard_pct(f.net, t.net),
  public.dashboard_pct(-f.costs, f.net)
from accounts a
left join figures f on f.marketplace_account_id = a.id
left join payouts p on p.marketplace_account_id = a.id
left join quality q on q.marketplace_account_id = a.id
cross join total t
order by f.net desc nulls last, a.label;
$$;

revoke all on function public.dashboard_accounts(uuid, text, timestamptz, timestamptz) from anon, public;
grant execute on function public.dashboard_accounts(uuid, text, timestamptz, timestamptz) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dashboard_accounts'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: dashboard_accounts must be SECURITY INVOKER and closed to anon.';
  end if;
  if not has_function_privilege('authenticated', 'public.dashboard_accounts(uuid, text, timestamptz, timestamptz)'::regprocedure, 'EXECUTE') then
    raise exception 'dashboard_accounts must stay callable by signed-in users.';
  end if;
  raise notice 'Migration 0083 verified: dashboard_accounts reads the quality groups once; same columns, invoker-rights, closed to anon.';
end;
$$;

commit;
