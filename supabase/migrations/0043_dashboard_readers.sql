-- ============================================================================
-- 0043  Readers for the home dashboard
-- ============================================================================
-- The new home dashboard (after the legacy dashboard audit, 2026-09-17). Every
-- figure, share, change and chart position is worked out HERE, from the same
-- ledger readers as the marketplace screens, so the page only draws.
--
-- SCOPE: one currency (all marketplace accounts in it), or one account.
-- Currencies are never combined (A12).
--
-- WHAT IS ADDED (all read-only, security invoker)
--   dashboard_pct(), dashboard_change()   shared rounding helpers
--   dashboard_overview()     the month's figures, ratios, change against the
--                            month before, expected payouts and what needs
--                            attention
--   dashboard_waterfall()    "where the sales money goes": each step with its
--                            bar start and end on a 0-1000 scale
--   dashboard_daily()        each day's gross sales, net sales and contribution
--                            so far, on one shared 0-1000 scale
--   dashboard_cost_breakdown() marketplace costs by category, with shares
--   dashboard_accounts()     every account in the currency, side by side
--
-- THE RULES CARRIED OVER
--   * A figure that is not final keeps its status; a "so far" figure is
--     returned beside it, never in its place.
--   * A change is only given when both months' figures are final (or, for
--     sales and costs, when both months have figures).
--   * Net profit belongs to the whole currency: for one account it is given
--     only when that account is the only one in its currency.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0042.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create function public.dashboard_pct(p_part numeric, p_whole numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_part is null or p_whole is null or p_whole = 0 then null
    else round(p_part / abs(p_whole) * 100, 1)
  end;
$$;

create function public.dashboard_change(p_now numeric, p_before numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_now is null or p_before is null or p_before = 0 then null
    else round((p_now - p_before) / abs(p_before) * 100, 1)
  end;
$$;


-- ----------------------------------------------------------------------------
-- The month at a glance
-- ----------------------------------------------------------------------------

create function public.dashboard_overview(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  currency                       text,
  scope_label                    text,
  accounts                       bigint,
  has_marketplace_data           boolean,
  lines                          bigint,
  review_lines                   bigint,
  unknown_lines                  bigint,
  gross_sales                    text,
  sales_refunds                  text,
  seller_discounts               text,
  net_sales                      text,
  other_income                   text,
  marketplace_fees               text,
  fulfillment                    text,
  advertising                    text,
  other_marketplace_costs        text,
  non_recoverable_vat            text,
  marketplace_costs              text,
  figures_status                 text,
  contribution                   text,
  contribution_status            text,
  contribution_before_open_items text,
  contribution_reasons           text[],
  units_sold                     text,
  cogs                           text,
  units_without_product          text,
  units_without_cost             text,
  gross_profit                   text,
  gross_profit_status            text,
  gross_profit_before_open_items text,
  gross_profit_reasons           text[],
  net_available                  boolean,
  operating_expenses             text,
  external_advertising           text,
  net_profit                     text,
  net_profit_status              text,
  net_profit_before_open_items   text,
  net_profit_reasons             text[],
  input_vat_treatment            text,
  refunds_pct_of_gross           numeric,
  costs_pct_of_net_sales         numeric,
  fees_pct_of_net_sales          numeric,
  advertising_pct_of_net_sales   numeric,
  contribution_margin_pct        numeric,
  gross_margin_pct               numeric,
  net_margin_pct                 numeric,
  prev_has_marketplace_data      boolean,
  gross_sales_change_pct         numeric,
  net_sales_change_pct           numeric,
  marketplace_costs_change_pct   numeric,
  contribution_change_pct        numeric,
  gross_profit_change_pct        numeric,
  net_profit_change_pct          numeric,
  expected_payouts               bigint,
  expected_inflow                text,
  payouts_in_doubt               bigint,
  open_quality_items             bigint,
  unmatched_skus                 bigint,
  unplaced_expense_categories    bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_cur       record;
  v_prev      record;
  v_net       record;
  v_prev_net  record;
  v_has       boolean;
  v_prev_has  boolean;
  v_sole      boolean;
  v_label     text;
  v_accounts  bigint;
  v_costs     numeric;
  v_prev_cost numeric;
  v_payouts   bigint;
  v_inflow    numeric;
  v_doubt     bigint;
  v_quality   bigint;
  v_skus      bigint;
  v_expense_q bigint;
begin
  -- Months are calendar months; "the month before" is the same length back.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and (p_to at time zone 'UTC') = (date_trunc('month', p_from at time zone 'UTC') + interval '1 month') then
    v_prev_from := ((date_trunc('month', p_from at time zone 'UTC') - interval '1 month') at time zone 'UTC');
  end if;

  select count(*) into v_accounts
  from public.marketplace_accounts a
  where a.business_id = p_business_id and a.currency = p_currency
    and (p_account_id is null or a.id = p_account_id);
  v_sole := (select count(*) from public.marketplace_accounts a
             where a.business_id = p_business_id and a.currency = p_currency) = 1;

  if p_account_id is null then
    v_label := 'All ' || p_currency || ' marketplace accounts';
  else
    select a.label into v_label from public.marketplace_accounts a
    where a.id = p_account_id and a.business_id = p_business_id and a.currency = p_currency;
  end if;

  select s.* into v_cur
  from public.pnl_summary(p_from, p_to, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_has := found;

  select s.* into v_prev
  from public.pnl_summary(v_prev_from, p_from, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_prev_has := found;

  -- Always read (a record must be assigned before the final query touches
  -- it); used below only when net profit belongs to this scope.
  select n.* into v_net from public.pnl_net_profit(p_from, p_to, p_business_id) n where n.currency = p_currency;
  select n.* into v_prev_net from public.pnl_net_profit(v_prev_from, p_from, p_business_id) n where n.currency = p_currency;

  if v_has then
    v_costs := v_cur.marketplace_fees::numeric + v_cur.fulfillment::numeric + v_cur.advertising::numeric
             + v_cur.other_marketplace_costs::numeric + v_cur.non_recoverable_vat::numeric;
  end if;
  if v_prev_has then
    v_prev_cost := v_prev.marketplace_fees::numeric + v_prev.fulfillment::numeric + v_prev.advertising::numeric
                 + v_prev.other_marketplace_costs::numeric + v_prev.non_recoverable_vat::numeric;
  end if;

  select count(*), sum(e.expected_amount::numeric), count(*) filter (where e.marketplace_status = 'DOES_NOT_ADD_UP')
    into v_payouts, v_inflow, v_doubt
  from public.expected_payouts(p_business_id, p_from, p_to, p_account_id) e
  where e.currency = p_currency;

  select count(*) into v_quality
  from public.ledger_data_quality(p_from, p_to, p_account_id, p_business_id) q
  where q.currency = p_currency and q.issue_kind <> 'UNDER_REVIEW';

  select count(*) into v_skus
  from public.sku_mapping_queue(p_business_id) q
  where position(p_currency in q.currencies) > 0;

  select count(*) into v_expense_q
  from public.expense_category_queue(p_business_id) q
  where position(p_currency in q.currencies) > 0;

  return query select
    p_currency,
    coalesce(v_label, p_currency),
    v_accounts,
    v_has,
    case when v_has then v_cur.lines end,
    case when v_has then v_cur.review_lines end,
    case when v_has then v_cur.unknown_lines end,
    case when v_has then v_cur.gross_sales end,
    case when v_has then v_cur.sales_refunds end,
    case when v_has then v_cur.seller_discounts end,
    case when v_has then v_cur.net_sales end,
    case when v_has then v_cur.other_income end,
    case when v_has then v_cur.marketplace_fees end,
    case when v_has then v_cur.fulfillment end,
    case when v_has then v_cur.advertising end,
    case when v_has then v_cur.other_marketplace_costs end,
    case when v_has then v_cur.non_recoverable_vat end,
    v_costs::numeric(20,4)::text,
    case when v_has then v_cur.figures_status end,
    case when v_has then v_cur.contribution end,
    case when v_has then v_cur.contribution_status else 'INCOMPLETE' end,
    case when v_has then v_cur.contribution_before_open_items end,
    case when v_has then v_cur.incomplete_reasons else array['NO_MARKETPLACE_DATA'] end,
    case when v_has then v_cur.units_sold end,
    case when v_has then v_cur.cogs end,
    case when v_has then v_cur.units_without_product end,
    case when v_has then v_cur.units_without_cost end,
    case when v_has then v_cur.gross_profit end,
    case when v_has then v_cur.gross_profit_status else 'INCOMPLETE' end,
    case when v_has then v_cur.gross_profit_before_open_items end,
    case when v_has then v_cur.gross_profit_reasons else array['NO_MARKETPLACE_DATA'] end,
    (p_account_id is null or v_sole),
    case when p_account_id is null or v_sole then coalesce(v_net.operating_expenses, '0.0000') end,
    case when p_account_id is null or v_sole then coalesce(v_net.external_advertising, '0.0000') end,
    case when p_account_id is null or v_sole then v_net.net_profit end,
    case when p_account_id is null or v_sole then coalesce(v_net.net_profit_status, 'INCOMPLETE') else 'INCOMPLETE' end,
    case when p_account_id is null or v_sole then v_net.net_profit_before_open_items end,
    case
      when p_account_id is not null and not v_sole then array['EXPENSES_BUSINESS_WIDE']
      else coalesce(v_net.net_profit_reasons, array['NO_MARKETPLACE_DATA'])
    end,
    case when v_has then v_cur.input_vat_treatment end,
    case when v_has then public.dashboard_pct(-v_cur.sales_refunds::numeric, v_cur.gross_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_costs, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_cur.marketplace_fees::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_cur.advertising::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(v_cur.contribution::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(v_cur.gross_profit::numeric, v_cur.net_sales::numeric) end,
    case when v_has and (p_account_id is null or v_sole) then public.dashboard_pct(v_net.net_profit::numeric, v_cur.net_sales::numeric) end,
    v_prev_has,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.gross_sales::numeric, v_prev.gross_sales::numeric) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.net_sales::numeric, v_prev.net_sales::numeric) end,
    -- Costs are negative; a rise in costs is a positive change in their size.
    case when v_has and v_prev_has then public.dashboard_change(-v_costs, -v_prev_cost) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.contribution::numeric, v_prev.contribution::numeric) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.gross_profit::numeric, v_prev.gross_profit::numeric) end,
    case when p_account_id is null or v_sole then public.dashboard_change(v_net.net_profit::numeric, v_prev_net.net_profit::numeric) end,
    coalesce(v_payouts, 0),
    v_inflow::numeric(20,4)::text,
    coalesce(v_doubt, 0),
    coalesce(v_quality, 0),
    coalesce(v_skus, 0),
    coalesce(v_expense_q, 0);
end;
$$;


-- ----------------------------------------------------------------------------
-- Where the sales money goes
-- ----------------------------------------------------------------------------

create function public.dashboard_waterfall(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  step       integer,
  label      text,
  kind       text,
  amount     text,
  status     text,
  bar_from   integer,
  bar_to     integer,
  zero_at    integer
)
language sql
stable
security invoker
set search_path = ''
as $$
with o as (
  select * from public.dashboard_overview(p_business_id, p_currency, p_from, p_to, p_account_id)
),
steps as (
  select v.step, v.label, v.kind, v.amount::numeric as amount, v.status
  from o, lateral (values
    (1,  'Gross sales',                 'TOTAL', o.gross_sales,              o.figures_status),
    (2,  'Refunds',                     'DELTA', o.sales_refunds,            o.figures_status),
    (3,  'Seller discounts',            'DELTA', o.seller_discounts,         o.figures_status),
    (4,  'Net sales',                   'TOTAL', o.net_sales,                o.figures_status),
    (5,  'Other income',                'DELTA', o.other_income,             o.figures_status),
    (6,  'Marketplace fees',            'DELTA', o.marketplace_fees,         o.figures_status),
    (7,  'Fulfilment',                  'DELTA', o.fulfillment,              o.figures_status),
    (8,  'Advertising',                 'DELTA', o.advertising,              o.figures_status),
    (9,  'Other marketplace costs',     'DELTA', o.other_marketplace_costs,  o.figures_status),
    (10, 'Non-recoverable VAT',         'DELTA', o.non_recoverable_vat,      o.figures_status),
    (11, 'Contribution',                'TOTAL', o.contribution_before_open_items, o.contribution_status),
    (12, 'Cost of goods',               'DELTA', o.cogs,                     o.gross_profit_status),
    (13, 'Gross profit',                'TOTAL', o.gross_profit_before_open_items, o.gross_profit_status),
    (14, 'Operating expenses',          'DELTA', case when o.net_available then o.operating_expenses end, o.net_profit_status),
    (15, 'Advertising elsewhere',       'DELTA', case when o.net_available then o.external_advertising end, o.net_profit_status),
    (16, 'Net profit',                  'TOTAL', case when o.net_available then o.net_profit_before_open_items end, o.net_profit_status)
  ) as v(step, label, kind, amount, status)
  where o.has_marketplace_data
    and v.amount is not null
    -- Optional steps appear only when they carry something.
    and not (v.step in (3, 5, 9, 10, 14, 15) and v.amount::numeric = 0)
),
running as (
  select
    s.*,
    case when s.kind = 'TOTAL' then 0::numeric
         else coalesce(max(s.amount) filter (where s.step = 1) over (), 0)
              + coalesce(sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and 1 preceding), 0)
    end as start_value,
    case when s.kind = 'TOTAL' then s.amount
         else coalesce(max(s.amount) filter (where s.step = 1) over (), 0)
              + sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and current row)
    end as end_value
  from steps s
),
domain as (
  select least(0, min(least(r.start_value, r.end_value))) as lo,
         greatest(0, max(greatest(r.start_value, r.end_value))) as hi
  from running r
)
select
  r.step,
  r.label,
  r.kind,
  r.amount::numeric(20,4)::text,
  r.status,
  case when d.hi = d.lo then 0 else round((least(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((greatest(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((0 - d.lo) / (d.hi - d.lo) * 1000)::integer end
from running r cross join domain d
order by r.step;
$$;


-- ----------------------------------------------------------------------------
-- Day by day
-- ----------------------------------------------------------------------------

create function public.dashboard_daily(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  day            date,
  has_lines      boolean,
  gross_sales    text,
  net_sales      text,
  contribution   text,
  gross_y        integer,
  net_y          integer,
  contribution_y integer,
  zero_y         integer
)
language sql
stable
security invoker
set search_path = ''
as $$
with days as (
  select d::date as day
  from generate_series((p_from at time zone 'UTC')::date, (p_to at time zone 'UTC')::date - 1, interval '1 day') d
),
lines as (
  select
    (x.posted_at at time zone 'UTC')::date as day,
    count(*) as n,
    coalesce(sum(x.amount::numeric) filter (where x.metric_group = 'GROSS_SALES'), 0) as gross,
    coalesce(sum(x.amount::numeric) filter (where x.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net,
    coalesce(sum(x.amount::numeric) filter (where x.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0) as contrib
  from public.ledger_classified_lines x
  join public.marketplace_accounts a on a.id = x.marketplace_account_id
  where x.business_id = p_business_id
    and a.currency = p_currency
    and (p_account_id is null or x.marketplace_account_id = p_account_id)
    and x.posted_at >= p_from and x.posted_at < p_to
  group by 1
),
joined as (
  select d.day, l.n is not null as has_lines,
         coalesce(l.gross, 0) as gross, coalesce(l.net, 0) as net, coalesce(l.contrib, 0) as contrib
  from days d left join lines l on l.day = d.day
),
domain as (
  select least(0, min(least(j.gross, j.net, j.contrib))) as lo,
         greatest(0, max(greatest(j.gross, j.net, j.contrib))) as hi
  from joined j
)
select
  j.day,
  j.has_lines,
  j.gross::numeric(20,4)::text,
  j.net::numeric(20,4)::text,
  j.contrib::numeric(20,4)::text,
  case when d.hi = d.lo then 0 else round((j.gross - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((j.net - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((j.contrib - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((0 - d.lo) / (d.hi - d.lo) * 1000)::integer end
from joined j cross join domain d
order by j.day;
$$;


-- ----------------------------------------------------------------------------
-- Where the marketplace costs go
-- ----------------------------------------------------------------------------

create function public.dashboard_cost_breakdown(
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
with scoped as (
  select x.*
  from public.ledger_classified_lines x
  join public.marketplace_accounts a on a.id = x.marketplace_account_id
  where x.business_id = p_business_id
    and a.currency = p_currency
    and (p_account_id is null or x.marketplace_account_id = p_account_id)
    and x.posted_at >= p_from and x.posted_at < p_to
),
net as (
  select coalesce(sum(s.amount::numeric) filter (where s.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales
  from scoped s
),
costs as (
  select
    s.category,
    case when s.metric_group = 'INPUT_VAT' then 'Non-recoverable VAT on fees' else s.category_label end as label,
    count(*) as lines,
    sum(s.amount::numeric) as total
  from scoped s
  where s.pnl_treatment = 'INCREASE_EXPENSE'
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
-- Every account in the currency
-- ----------------------------------------------------------------------------

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
  units_sold              text,
  gross_profit            text,
  gross_profit_status     text,
  expected_inflow         text,
  expected_payouts        bigint,
  open_quality_items      bigint,
  share_of_net_sales_pct  numeric
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
figures as (
  select s.* from public.pnl_summary(p_from, p_to, null, p_business_id, false) s
  where s.currency = p_currency
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
  select sum(f.net_sales::numeric) as net_sales from figures f
)
select
  a.id,
  a.label,
  a.marketplace_code,
  f.marketplace_account_id is not null,
  f.gross_sales,
  f.sales_refunds,
  f.net_sales,
  (f.marketplace_fees::numeric + f.fulfillment::numeric + f.advertising::numeric
     + f.other_marketplace_costs::numeric + f.non_recoverable_vat::numeric)::numeric(20,4)::text,
  f.advertising,
  f.contribution,
  coalesce(f.contribution_status, 'INCOMPLETE'),
  f.contribution_before_open_items,
  public.dashboard_pct(f.contribution::numeric, f.net_sales::numeric),
  f.units_sold,
  f.gross_profit,
  coalesce(f.gross_profit_status, 'INCOMPLETE'),
  p.inflow::numeric(20,4)::text,
  coalesce(p.n, 0),
  coalesce(q.n, 0),
  public.dashboard_pct(f.net_sales::numeric, t.net_sales)
from accounts a
left join figures f on f.marketplace_account_id = a.id
left join payouts p on p.marketplace_account_id = a.id
left join quality q on q.marketplace_account_id = a.id
cross join total t
order by f.net_sales::numeric desc nulls last, a.label;
$$;


-- ----------------------------------------------------------------------------
-- Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.dashboard_pct(numeric, numeric)',
    'public.dashboard_change(numeric, numeric)',
    'public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid)',
    'public.dashboard_waterfall(uuid, text, timestamptz, timestamptz, uuid)',
    'public.dashboard_daily(uuid, text, timestamptz, timestamptz, uuid)',
    'public.dashboard_cost_breakdown(uuid, text, timestamptz, timestamptz, uuid)',
    'public.dashboard_accounts(uuid, text, timestamptz, timestamptz)'
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
  foreach f in array array['dashboard_overview', 'dashboard_waterfall', 'dashboard_daily',
                           'dashboard_cost_breakdown', 'dashboard_accounts', 'dashboard_pct', 'dashboard_change']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
  end loop;

  if public.dashboard_pct(-25, 200) <> -12.5 or public.dashboard_pct(1, 0) is not null
     or public.dashboard_change(150, 100) <> 50.0 or public.dashboard_change(-50, -100) <> 50.0
     or public.dashboard_change(1, null) is not null then
    raise exception 'SELF-CHECK: dashboard_pct or dashboard_change do not behave as intended.';
  end if;

  raise notice 'Migration 0043 verified: dashboard readers are read-only invoker functions.';
end;
$$;

commit;
