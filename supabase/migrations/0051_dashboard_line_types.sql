-- ============================================================================
-- 0051  Dashboard: classify each line TYPE once, for accounts and costs
-- ============================================================================
-- After 0050 the 12-month executive dashboard loads, but in about 10 seconds
-- on the owner's data (~33,000 lines): dashboard_accounts() ran the full
-- line-by-line pnl_summary() per account (3.5 s) while the other readers ran.
-- dashboard_monthly() (0049) already shows the faster way -- group lines by
-- account and line type first, then classify each type once -- at 0.6 s.
--
-- WHAT CHANGES (read-only; nothing is stored)
--   1. dashboard_line_types(): the scoped lines grouped by account and line
--      type, each type classified with EXACTLY the ledger_classified_lines
--      view's rule choice and treatment. A building block for the two below.
--   2. dashboard_accounts(): figures per account from those groups; its
--      Final / Incomplete judged exactly as pnl_summary() judges an account
--      (unrecognised lines, VAT setting unknown, fee VAT not separated, rows
--      with errors). units_sold, gross_profit and gross_profit_status are
--      dropped: no screen shows them per account, and they need the per-line
--      cost lookup this avoids. Dropped and recreated (its result changes).
--   3. dashboard_cost_breakdown(): the same, from the groups. Same result.
--
-- Nothing in the ledger, classification, VAT or P&L changes; the P&L engine
-- itself is untouched and the live tests compare every figure with it.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Lines grouped by account and type, each type classified once
-- ----------------------------------------------------------------------------

create function public.dashboard_line_types(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  marketplace_account_id uuid,
  lines                  bigint,
  amount                 numeric,
  files                  uuid[],
  rule_id                uuid,
  category               text,
  category_label         text,
  metric_group           text,
  pnl_treatment          text,
  rule_includes_vat      boolean,
  rule_separates_vat     boolean,
  vat_setting            text
)
language sql
stable
security invoker
set search_path = ''
as $$
with groups as (
  select
    ft.marketplace_account_id,
    a.marketplace_code,
    b.format_id,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
    count(*)                                  as lines,
    sum(ft.amount)                            as amount,
    array_agg(distinct ft.source_file_id)     as files
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where ft.business_id = p_business_id
    and a.currency = p_currency
    and (p_account_id is null or ft.marketplace_account_id = p_account_id)
    and ft.posted_at >= p_from and ft.posted_at < p_to
  group by 1, 2, 3, 4
)
select
  g.marketplace_account_id,
  g.lines,
  g.amount,
  g.files,
  r.id,
  r.category,
  c.label,
  c.metric_group,
  case
    when r.id is null then null
    when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
    when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
    when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
    else 'CONDITIONAL'
  end,
  coalesce(r.amount_includes_vat, false),
  coalesce(r.separates_included_vat, false),
  coalesce(tp.input_vat_treatment, 'UNKNOWN')
from groups g
left join public.tax_profiles tp on tp.marketplace_account_id = g.marketplace_account_id
left join lateral (
  -- Exactly the ledger_classified_lines view's rule choice (0035).
  select cr.id, cr.category, cr.amount_includes_vat, cr.separates_included_vat
  from public.classification_rules cr
  where cr.status = 'ACTIVE'
    and cr.marketplace_code = g.marketplace_code
    and cr.format_id = g.format_id
    and cr.match_key = g.match_key
    and (cr.business_id is null or cr.business_id = p_business_id)
  order by case
             when cr.business_id is null and cr.confidence = 'HIGH' then 1
             when cr.business_id is not null then 2
             else 3
           end
  limit 1
) r on true
left join public.classification_categories c on c.code = r.category;
$$;


-- ----------------------------------------------------------------------------
-- 2. Every account in the currency
-- ----------------------------------------------------------------------------

drop function public.dashboard_accounts(uuid, text, timestamptz, timestamptz);

create function public.dashboard_accounts(
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
  -- A file with unreadable rows keeps its account's figures from being final.
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
    -- Not final exactly as pnl_summary() judges an account over a period.
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
quality as (
  select q.marketplace_account_id, count(*) as n
  from public.ledger_data_quality(p_from, p_to, null, p_business_id) q
  where q.currency = p_currency and q.issue_kind <> 'UNDER_REVIEW'
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


-- ----------------------------------------------------------------------------
-- 3. Where the marketplace costs go
-- ----------------------------------------------------------------------------

create or replace function public.dashboard_cost_breakdown(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  category          text,
  label             text,
  lines             bigint,
  total             text,
  pct_of_net_sales  numeric,
  pct_of_costs      numeric,
  bar               integer
)
language sql
stable
security invoker
set search_path = ''
as $$
with types as (
  select * from public.dashboard_line_types(p_business_id, p_currency, p_from, p_to, p_account_id)
),
net as (
  select coalesce(sum(t.amount) filter (where t.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales
  from types t
),
costs as (
  select
    t.category,
    case when t.metric_group = 'INPUT_VAT' then 'Non-recoverable VAT on fees' else t.category_label end as label,
    sum(t.lines)::bigint as lines,
    sum(t.amount) as total
  from types t
  where t.pnl_treatment = 'INCREASE_EXPENSE'
  group by 1, 2
),
totals as (
  select sum(c.total) as all_costs, min(c.total) as largest from costs c
)
select
  c.category,
  c.label,
  c.lines,
  c.total::numeric(20,4)::text,
  public.dashboard_pct(-c.total, n.net_sales),
  public.dashboard_pct(c.total, t.all_costs),
  case when t.largest is null or t.largest = 0 then 0 else round(c.total / t.largest * 1000)::integer end
from costs c cross join net n cross join totals t
order by c.total, c.label;
$$;


-- ----------------------------------------------------------------------------
-- 4. Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.dashboard_line_types(uuid, text, timestamptz, timestamptz, uuid)',
    'public.dashboard_accounts(uuid, text, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('dashboard_line_types', 'dashboard_accounts', 'dashboard_cost_breakdown')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the dashboard readers must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0051 verified: accounts and costs classify each line type once.';
end;
$$;

commit;
