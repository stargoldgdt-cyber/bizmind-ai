-- ============================================================================
-- 0070  product_analysis(): everything the product analysis page shows
-- ============================================================================
-- The page a seller reaches from "Review product" on Product profitability.
-- ONE read-only function works out every figure on it, in SQL, from the same
-- lines pnl_by_product() reads (ledger_product_lines, ORDER_LINE attribution,
-- the same three P&L treatments), so a product's page can never disagree with
-- its row in the table:
--
--   kpis         the selected month and the month before: units, net sales,
--                marketplace costs, COGS, gross profit and margin, with the
--                change against last month (a percentage, or points for margin)
--   months       the 12 months ending with the selected one, net sales and
--                gross profit pre-scaled to 0-1000 for the chart
--   marketplaces the selected month, one row per marketplace account
--   costs        marketplace costs by category (same shape as
--                dashboard_cost_breakdown, so the donut is reused)
--   price        average selling price, cost and fees per unit, the break-even
--                price and the price a target margin would need
--   orders       the latest orders in the selected month
--
-- Nothing is allocated across products that the marketplace did not attribute
-- to one (A7), and nothing is converted between currencies: one currency per
-- call, as everywhere else.
--
-- The price check is an ESTIMATE and says so: it keeps marketplace costs per
-- unit where they are. A commission that grows with the price would grow too.
-- Money returns as exact decimal text; percentages are numbers rounded to one
-- decimal. An incomplete figure (some sold units have no cost) is null, never
-- a number.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.product_analysis(
  p_business_id   uuid,
  p_product_id    uuid,
  p_currency      text,
  p_from          timestamptz,
  p_to            timestamptz,
  p_account_id    uuid default null,
  p_target_margin numeric default 15
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
params as (
  select
    p_from                                                                         as cur_from,
    ((p_from at time zone 'UTC' - interval '1 month') at time zone 'UTC')          as prev_from,
    ((p_from at time zone 'UTC' - interval '11 months') at time zone 'UTC')        as trend_from
),
base as (
  -- The product's own lines for the 12 months ending with the selected one:
  -- the same rows pnl_by_product() counts as a PRODUCT row.
  select
    l.posted_at,
    l.marketplace_account_id,
    l.account_label,
    l.marketplace_code,
    l.order_ref,
    l.category,
    l.category_label,
    l.metric_group,
    l.pnl_treatment,
    l.amount::numeric(20,4)  as amt,
    l.quantity::numeric      as qty,
    l.is_cost_line,
    l.cogs_status,
    l.cogs::numeric          as cogs
  from public.ledger_product_lines l, params p
  where l.business_id = p_business_id
    and l.product_id = p_product_id
    and l.currency = p_currency
    and l.posted_at >= p.trend_from
    and l.posted_at < p_to
    and l.attribution = 'ORDER_LINE'
    and l.raw_sku is not null
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and l.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')
),
periods as (
  select
    case when b.posted_at >= p.cur_from then 'cur' else 'prev' end as period,
    coalesce(sum(b.qty) filter (where b.is_cost_line), 0)                                      as units,
    coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(b.amt) filter (where b.pnl_treatment = 'INCREASE_EXPENSE'), 0)                as costs,
    coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0)                           as cogs,
    count(*) filter (where b.cogs_status = 'COSTED')                                           as costed,
    count(*) filter (where b.cogs_status in ('NO_COST', 'NO_PRODUCT'))                         as uncosted,
    sum(b.amt)                                                                                 as contribution,
    count(*)                                                                                   as lines
  from base b, params p
  where b.posted_at >= p.prev_from
  group by 1
),
kp as (
  select
    q.period,
    q.units,
    q.net_sales,
    q.costs,
    case when q.uncosted = 0 then q.cogs end                                                   as cogs,
    case when q.uncosted = 0 then q.contribution + q.cogs end                                  as gross_profit,
    case when q.uncosted = 0 and q.net_sales <> 0
         then round((q.contribution + q.cogs) / q.net_sales * 100, 1) end                      as margin,
    case when q.net_sales > 0 then round(abs(q.costs) / q.net_sales * 100, 1) end              as costs_pct,
    case when q.uncosted = 0 and q.net_sales > 0 then round(abs(q.cogs) / q.net_sales * 100, 1) end as cogs_pct,
    case
      when q.uncosted = 0 and q.costed > 0 then 'COSTED'
      when q.uncosted = 0 then 'NOT_APPLICABLE'
      when q.costed = 0 then 'NO_COST'
      else 'PARTLY_COSTED'
    end                                                                                        as cogs_status,
    q.lines
  from periods q
),
kp_json as (
  -- Money crosses as exact decimal text; percentages as numbers.
  select
    k.*,
    jsonb_build_object(
      'units',        k.units::numeric(20,4)::text,
      'net_sales',    k.net_sales::numeric(20,4)::text,
      'costs',        k.costs::numeric(20,4)::text,
      'cogs',         k.cogs::numeric(20,4)::text,
      'gross_profit', k.gross_profit::numeric(20,4)::text,
      'margin',       k.margin::text,
      'costs_pct',    k.costs_pct,
      'cogs_pct',     k.cogs_pct,
      'cogs_status',  k.cogs_status,
      'lines',        k.lines
    ) as j
  from kp k
),
cur as (select * from kp_json where period = 'cur'),
prev as (select * from kp_json where period = 'prev'),
changes as (
  -- Against the month before. The denominator is the absolute value of last
  -- month, so a loss that grows reads as a fall, not a rise.
  select
    case when pv.net_sales <> 0 then round((c.net_sales - pv.net_sales) / abs(pv.net_sales) * 100, 1) end as net_sales_pct,
    case when pv.units <> 0 then round((c.units - pv.units) / abs(pv.units) * 100, 1) end                 as units_pct,
    case when pv.gross_profit is not null and c.gross_profit is not null and pv.gross_profit <> 0
         then round((c.gross_profit - pv.gross_profit) / abs(pv.gross_profit) * 100, 1) end               as gross_profit_pct,
    case when pv.margin is not null and c.margin is not null then round(c.margin - pv.margin, 1) end      as margin_points
  from cur c left join prev pv on true
),
series as (
  select
    m.month,
    count(b.posted_at) > 0                                                                     as has_lines,
    coalesce(sum(b.qty) filter (where b.is_cost_line), 0)                                      as units,
    coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(b.amt) filter (where b.pnl_treatment = 'INCREASE_EXPENSE'), 0)                as costs,
    case when count(b.posted_at) > 0
          and count(*) filter (where b.cogs_status in ('NO_COST', 'NO_PRODUCT')) = 0
         then coalesce(sum(b.amt), 0) + coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0) end as gross_profit
  from (
    select generate_series(
             date_trunc('month', (select trend_from from params) at time zone 'UTC'),
             date_trunc('month', (select cur_from from params) at time zone 'UTC'),
             interval '1 month')::date as month
  ) m
  left join base b on date_trunc('month', b.posted_at at time zone 'UTC')::date = m.month
  group by m.month
),
scaled as (
  -- One scale for every bar and point, so the page draws and never scales
  -- money. 0 is the bottom, 1000 the top; zero_y is where the zero line sits.
  select
    s.*,
    greatest(max(greatest(s.net_sales, coalesce(s.gross_profit, 0), 0)) over (), 0)            as hi,
    least(min(least(s.net_sales, coalesce(s.gross_profit, 0), 0)) over (), 0)                  as lo
  from series s
),
months_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'month',        d.month,
    'has_lines',    d.has_lines,
    'units',        d.units::numeric(20,4)::text,
    'net_sales',    d.net_sales::numeric(20,4)::text,
    'costs',        d.costs::numeric(20,4)::text,
    'gross_profit', d.gross_profit::numeric(20,4)::text,
    'margin',       case when d.gross_profit is not null and d.net_sales <> 0
                         then round(d.gross_profit / d.net_sales * 100, 1)::text end,
    'net_sales_y',  round((d.net_sales - d.lo) / d.span * 1000),
    'gross_profit_y', case when d.gross_profit is not null then round((d.gross_profit - d.lo) / d.span * 1000) end,
    'zero_y',       round((0 - d.lo) / d.span * 1000)
  ) order by d.month), '[]'::jsonb) as j
  from (select sc.*, greatest(sc.hi - sc.lo, 1) as span from scaled sc) d
),
marketplaces_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'account_id',       g.marketplace_account_id,
    'account_label',    g.account_label,
    'marketplace_code', g.marketplace_code,
    'units',            g.units::numeric(20,4)::text,
    'net_sales',        g.net_sales::numeric(20,4)::text,
    'costs',            g.costs::numeric(20,4)::text,
    'cogs',             case when g.uncosted = 0 then g.cogs::numeric(20,4)::text end,
    'gross_profit',     case when g.uncosted = 0 then (g.contribution + g.cogs)::numeric(20,4)::text end,
    'margin',           case when g.uncosted = 0 and g.net_sales <> 0
                             then round((g.contribution + g.cogs) / g.net_sales * 100, 1)::text end
  ) order by g.net_sales desc), '[]'::jsonb) as j
  from (
    select
      b.marketplace_account_id, b.account_label, b.marketplace_code,
      coalesce(sum(b.qty) filter (where b.is_cost_line), 0)                                    as units,
      coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
      coalesce(sum(b.amt) filter (where b.pnl_treatment = 'INCREASE_EXPENSE'), 0)              as costs,
      coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0)                         as cogs,
      count(*) filter (where b.cogs_status in ('NO_COST', 'NO_PRODUCT'))                       as uncosted,
      sum(b.amt)                                                                               as contribution
    from base b, params p
    where b.posted_at >= p.cur_from
    group by b.marketplace_account_id, b.account_label, b.marketplace_code
  ) g
),
fee_rows as (
  select
    b.category,
    max(b.category_label)                  as label,
    count(*)                               as lines,
    sum(b.amt)                             as total
  from base b, params p
  where b.posted_at >= p.cur_from and b.pnl_treatment = 'INCREASE_EXPENSE'
  group by b.category
),
costs_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'category',         f.category,
    'label',            coalesce(f.label, f.category),
    'lines',            f.lines,
    'total',            f.total::numeric(20,4)::text,
    'pct_of_net_sales', case when (select net_sales from cur) > 0
                             then round(abs(f.total) / (select net_sales from cur) * 100, 1) end,
    'pct_of_costs',     case when t.total <> 0 then round(abs(f.total) / abs(t.total) * 100, 1) end,
    'bar',              case when t.total <> 0 then round(abs(f.total) / abs(t.total) * 1000) else 0 end
  ) order by abs(f.total) desc), '[]'::jsonb) as j,
  coalesce(max(t.total), 0)::numeric(20,4)::text as total
  from fee_rows f, (select coalesce(sum(total), 0) as total from fee_rows) t
),
order_rows as (
  select
    b.order_ref,
    b.marketplace_code,
    max(b.posted_at)                                                                           as posted_at,
    coalesce(sum(b.qty) filter (where b.is_cost_line), 0)                                      as units,
    coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    case when count(*) filter (where b.cogs_status in ('NO_COST', 'NO_PRODUCT')) = 0
         then coalesce(sum(b.amt), 0) + coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0) end as profit
  from base b, params p
  where b.posted_at >= p.cur_from and b.order_ref is not null
  group by b.order_ref, b.marketplace_code
  order by max(b.posted_at) desc
  limit 10
),
orders_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_ref',        o.order_ref,
    'marketplace_code', o.marketplace_code,
    'posted_at',        o.posted_at,
    'units',            o.units::numeric(20,4)::text,
    'net_sales',        o.net_sales::numeric(20,4)::text,
    'profit',           o.profit::numeric(20,4)::text
  ) order by o.posted_at desc), '[]'::jsonb) as j
  from order_rows o
),
price as (
  -- Per unit sold, this month. Null unless there are units, sales and a cost
  -- for every unit: a price check on a guess would be worse than none.
  select
    case when c.units > 0 and c.net_sales > 0 and c.cogs is not null then
      jsonb_build_object(
        'target_margin',     p_target_margin,
        'average_price',     (c.net_sales / c.units)::numeric(20,4)::text,
        'unit_cogs',         (abs(c.cogs) / c.units)::numeric(20,4)::text,
        'unit_costs',        (abs(c.costs) / c.units)::numeric(20,4)::text,
        'break_even_price',  ((abs(c.cogs) + abs(c.costs)) / c.units)::numeric(20,4)::text,
        'required_price',    case when p_target_margin < 100
                                  then (((abs(c.cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100))::numeric(20,4)::text end,
        'increase_amount',   case when p_target_margin < 100
                                  then ((((abs(c.cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100)) - c.net_sales / c.units)::numeric(20,4)::text end,
        'increase_pct',      case when p_target_margin < 100
                                  then round(((((abs(c.cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100)) / (c.net_sales / c.units) - 1) * 100, 1) end
      )
    end as j
  from cur c
)
select jsonb_build_object(
  'currency', p_currency,
  'current', (select j from cur),
  'previous', (select j from prev),
  'changes', (select to_jsonb(ch) from changes ch),
  'months', (select j from months_json),
  'marketplaces', (select j from marketplaces_json),
  'costs', (select j from costs_json),
  'costs_total', (select total from costs_json),
  'price', (select j from price),
  'orders', (select j from orders_json)
);
$$;

revoke all on function public.product_analysis(uuid, uuid, text, timestamptz, timestamptz, uuid, numeric) from anon, public;
grant execute on function public.product_analysis(uuid, uuid, text, timestamptz, timestamptz, uuid, numeric) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'product_analysis'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: product_analysis must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0070 verified: product_analysis is read-only, invoker-rights, closed to anon.';
end;
$$;

commit;
