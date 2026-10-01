-- ============================================================================
-- 0049  The executive dashboard: any period, month by month, lighter
-- ============================================================================
-- The home dashboard becomes the whole business at a glance (owner request,
-- 2026-09-21): all marketplace accounts together, any period, and a
-- month-by-month trend by marketplace. Measured on the owner's data first:
-- 12 months of dashboard_overview() took 5.2 s, and dashboard_waterfall()
-- ran all of it a second time just to place its bars.
--
-- WHAT CHANGES (read-only; nothing is stored)
--   1. dashboard_overview(): a whole-month range of any length compares with
--      the same number of months just before it. Otherwise 0046's.
--   2. dashboard_waterfall_steps(overview): the waterfall worked out from the
--      overview row the page already has -- no second pass over the ledger.
--      dashboard_waterfall() stays for callers that have no overview row.
--   3. dashboard_accounts(): + costs_pct_of_net_sales (dropped and recreated:
--      its result gains a column). Otherwise 0043's.
--   4. dashboard_monthly(): net sales, marketplace costs and contribution per
--      month and account, with each month's Final / Incomplete judged exactly
--      as pnl_summary() judges an account, and chart positions on one 0-1000
--      scale. Each line type is classified once, as in 0047.
--
-- Nothing in the ledger, classification, VAT or P&L changes.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- 1. dashboard_overview ------------------------------------------------------

create or replace function public.dashboard_overview(
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
  v_months    integer;
begin
  -- 0049: any whole-month range compares with the same number of months just
  -- before it (a month with the month before, a quarter with the quarter
  -- before, 12 months with the 12 before). Other ranges are not compared.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and date_trunc('month', p_to at time zone 'UTC') = (p_to at time zone 'UTC')
     and p_to > p_from then
    v_months := (extract(year from p_to at time zone 'UTC')::integer * 12 + extract(month from p_to at time zone 'UTC')::integer)
              - (extract(year from p_from at time zone 'UTC')::integer * 12 + extract(month from p_from at time zone 'UTC')::integer);
    v_prev_from := (((p_from at time zone 'UTC') - make_interval(months => v_months)) at time zone 'UTC');
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

  -- SKUs sold in THIS scope and month with no product (0046). The whole
  -- business's queue (sku_mapping_queue) was too slow to build per page view.
  select count(distinct (l.marketplace_code, l.raw_sku)) into v_skus
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.currency = p_currency
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and l.posted_at >= p_from and l.posted_at < p_to
    and l.raw_sku is not null
    and l.category = 'PRODUCT_SALES' and l.quantity is not null
    and not exists (
      select 1 from public.sku_aliases s
      where s.business_id = l.business_id and s.marketplace_code = l.marketplace_code
        and s.raw_sku = l.raw_sku and s.status = 'CONFIRMED'
    );

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


-- 2. dashboard_waterfall_steps -----------------------------------------------

create function public.dashboard_waterfall_steps(p_overview jsonb)
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
immutable
security invoker
set search_path = ''
as $$
with o as (
  -- The dashboard_overview() row the page already read: no data is touched
  -- here, only positions worked out from those figures.
  select * from jsonb_to_record(p_overview) as x(
    has_marketplace_data boolean, figures_status text,
    gross_sales text, sales_refunds text, seller_discounts text, net_sales text, other_income text,
    marketplace_fees text, fulfillment text, advertising text, other_marketplace_costs text,
    non_recoverable_vat text, contribution_before_open_items text, contribution_status text,
    cogs text, gross_profit_before_open_items text, gross_profit_status text,
    net_available boolean, operating_expenses text, external_advertising text,
    net_profit_before_open_items text, net_profit_status text
  )
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
  where coalesce(o.has_marketplace_data, false)
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


-- 3. dashboard_accounts ------------------------------------------------------

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
  units_sold              text,
  gross_profit            text,
  gross_profit_status     text,
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
  public.dashboard_pct(f.net_sales::numeric, t.net_sales),
  public.dashboard_pct(-(f.marketplace_fees::numeric + f.fulfillment::numeric + f.advertising::numeric
     + f.other_marketplace_costs::numeric + f.non_recoverable_vat::numeric), f.net_sales::numeric)
from accounts a
left join figures f on f.marketplace_account_id = a.id
left join payouts p on p.marketplace_account_id = a.id
left join quality q on q.marketplace_account_id = a.id
cross join total t
order by f.net_sales::numeric desc nulls last, a.label;
$$;


-- 4. dashboard_monthly -------------------------------------------------------

create function public.dashboard_monthly(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  month                 date,
  marketplace_account_id uuid,
  account_label         text,
  marketplace_code      text,
  has_lines             boolean,
  net_sales             text,
  marketplace_costs     text,
  contribution          text,
  contribution_status   text,
  month_net_sales       text,
  month_contribution    text,
  month_status          text,
  bar_from              integer,
  bar_to                integer,
  month_contribution_y  integer,
  zero_y                integer
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
    and (p_account_id is null or a.id = p_account_id)
),
months as (
  select m::date as month
  from generate_series(date_trunc('month', p_from at time zone 'UTC'),
                       (p_to at time zone 'UTC') - interval '1 day', interval '1 month') m
),
groups as (
  -- Lines grouped by account, month and line type first: a line's
  -- classification depends only on its type, so each type is classified once.
  select
    ft.marketplace_account_id,
    date_trunc('month', ft.posted_at at time zone 'UTC')::date                     as month,
    a.marketplace_code,
    b.format_id,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
    count(*)                                                                    as lines,
    sum(ft.amount)                                                              as amount,
    array_agg(distinct ft.source_file_id)                                       as files
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where ft.business_id = p_business_id
    and a.currency = p_currency
    and (p_account_id is null or ft.marketplace_account_id = p_account_id)
    and ft.posted_at >= p_from and ft.posted_at < p_to
  group by 1, 2, 3, 4, 5
),
classified as (
  -- Exactly the ledger_classified_lines view's rule choice and treatment.
  select
    g.*,
    r.id                                                                        as rule_id,
    c.metric_group,
    case
      when r.id is null then null
      when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
      when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
      when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
      else 'CONDITIONAL'
    end                                                                         as pnl_treatment,
    coalesce(r.amount_includes_vat, false)                                      as rule_includes_vat,
    coalesce(r.separates_included_vat, false)                                   as rule_separates_vat,
    coalesce(tp.input_vat_treatment, 'UNKNOWN')                                 as vat_setting
  from groups g
  left join public.tax_profiles tp on tp.marketplace_account_id = g.marketplace_account_id
  left join lateral (
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
  left join public.classification_categories c on c.code = r.category
),
row_errors as (
  -- A file with unreadable rows keeps the months it touches from being final.
  select distinct f.marketplace_account_id, f.month
  from (select distinct g.marketplace_account_id, g.month, unnest(g.files) as file_id from groups g) f
  where exists (select 1 from public.import_issues i where i.batch_id = f.file_id and i.severity = 'ERROR')
),
per_account_month as (
  select
    k.marketplace_account_id,
    k.month,
    coalesce(sum(k.amount) filter (where k.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(k.amount) filter (where k.metric_group in ('MARKETPLACE_FEES', 'FULFILLMENT', 'ADVERTISING', 'OTHER_MARKETPLACE_COSTS')
                                     or (k.metric_group = 'INPUT_VAT' and k.pnl_treatment = 'INCREASE_EXPENSE')), 0) as costs,
    coalesce(sum(k.amount) filter (where k.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0) as contribution,
    -- Not final exactly as pnl_summary() judges an account over a period.
    (bool_or(k.rule_id is null)
      or bool_or(k.pnl_treatment = 'CONDITIONAL')
      or (bool_or(k.rule_includes_vat) and not bool_or(k.rule_separates_vat) and min(k.vat_setting) <> 'NON_RECOVERABLE')
      or bool_or(e.marketplace_account_id is not null))                        as incomplete
  from classified k
  left join row_errors e on e.marketplace_account_id = k.marketplace_account_id and e.month = k.month
  group by k.marketplace_account_id, k.month
),
grid as (
  select m.month, a.id, a.label, a.marketplace_code, p.marketplace_account_id is not null as has_lines,
         coalesce(p.net_sales, 0) as net_sales, coalesce(p.costs, 0) as costs,
         coalesce(p.contribution, 0) as contribution, coalesce(p.incomplete, false) as incomplete
  from months m
  cross join accounts a
  left join per_account_month p on p.marketplace_account_id = a.id and p.month = m.month
),
by_month as (
  select g.month, sum(g.net_sales) as net_sales, sum(g.contribution) as contribution,
         bool_or(g.incomplete) as incomplete, bool_or(g.has_lines) as has_lines
  from grid g group by g.month
),
domain as (
  select least(0, (select min(least(g.net_sales, 0)) from grid g), min(b.contribution)) as lo,
         greatest(0, (select max(g.net_sales) from grid g), max(b.contribution)) as hi
  from by_month b
)
select
  g.month,
  g.id,
  g.label,
  g.marketplace_code,
  g.has_lines,
  g.net_sales::numeric(20,4)::text,
  g.costs::numeric(20,4)::text,
  g.contribution::numeric(20,4)::text,
  case when not g.has_lines then null when g.incomplete then 'INCOMPLETE' else 'FINAL' end,
  b.net_sales::numeric(20,4)::text,
  b.contribution::numeric(20,4)::text,
  case when not b.has_lines then null when b.incomplete then 'INCOMPLETE' else 'FINAL' end,
  case when d.hi = d.lo then 0 else round((least(g.net_sales, 0) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((greatest(g.net_sales, 0) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((b.contribution - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((0 - d.lo) / (d.hi - d.lo) * 1000)::integer end
from grid g
join by_month b on b.month = g.month
cross join domain d
order by g.month, g.label;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.dashboard_waterfall_steps(jsonb)',
    'public.dashboard_accounts(uuid, text, timestamptz, timestamptz)',
    'public.dashboard_monthly(uuid, text, timestamptz, timestamptz, uuid)'
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
      and p.proname in ('dashboard_overview', 'dashboard_waterfall_steps', 'dashboard_accounts', 'dashboard_monthly')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the dashboard readers must be SECURITY INVOKER and closed to anon.';
  end if;
  if (select count(*) from public.dashboard_waterfall_steps(jsonb_build_object(
        'has_marketplace_data', true, 'figures_status', 'FINAL', 'gross_sales', '100', 'sales_refunds', '-10',
        'seller_discounts', '0', 'net_sales', '90', 'other_income', '0', 'marketplace_fees', '-20',
        'fulfillment', '-5', 'advertising', '0', 'other_marketplace_costs', '0', 'non_recoverable_vat', '0',
        'contribution_before_open_items', '65', 'contribution_status', 'FINAL', 'cogs', '0',
        'gross_profit_before_open_items', '65', 'gross_profit_status', 'FINAL', 'net_available', false))) <> 9 then
    raise exception 'SELF-CHECK: dashboard_waterfall_steps does not build the expected steps.';
  end if;
  raise notice 'Migration 0049 verified: executive dashboard readers.';
end;
$$;

commit;
