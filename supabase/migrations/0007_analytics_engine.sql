-- ============================================================================
-- BizMind AI -- Migration 0007: Analytics engine
-- ============================================================================
--
-- The authoritative calculation layer. Every business figure in the product is
-- produced here and nowhere else.
--
-- WHY EVERYTHING LIVES IN SQL
-- ---------------------------
-- 1. `numeric` is exact decimal arithmetic. A figure parsed into a JavaScript
--    number becomes binary floating point, where 0.10 has no exact
--    representation and the error compounds across aggregation.
--
-- 2. It is the boundary that will keep the AI honest. The database computes,
--    the application displays, the AI explains. No layer above this one may
--    invent or recalculate a business number -- including period deltas, which
--    is why analytics_compare() returns the change rather than leaving it to
--    the caller.
--
-- SECURITY INVOKER throughout, so Row Level Security applies inside every
-- function. A caller asking about a business they do not belong to receives
-- zeros and empty sets -- not an error, which would confirm it exists.
--
-- DEFINITIONS (the contract the whole product depends on)
-- -------------------------------------------------------
--   revenue        SUM(orders.total) for orders placed in the period,
--                  excluding CANCELLED. Includes shipping and tax as charged.
--   cogs           SUM(quantity * unit_cost) over order lines, using the
--                  HISTORICAL cost recorded on the line. Lines with no cost
--                  contribute NOTHING and are counted separately. The current
--                  product catalogue is never consulted -- see migration 0005.
--   fees           SUM(orders.fee_total): marketplace commission, payment
--                  processing, fulfilment.
--   gross_profit   revenue - cogs - fees
--   gross_margin   gross_profit / revenue * 100, NULL when revenue is 0
--   expenses       SUM(expenses.amount) incurred in the period
--   net_profit     gross_profit - expenses
--   net_margin     net_profit / revenue * 100, NULL when revenue is 0
--   aov            revenue / order count, NULL when there are no orders
--   cost_coverage  order lines WITH a cost / all order lines * 100.
--                  Below 100 means gross profit is OVERSTATED.
--
-- HONESTY RULES
-- -------------
-- A ratio with a zero denominator returns NULL, never 0 and never infinity.
-- NULL means "cannot be calculated", which is a different fact from zero and
-- must stay distinguishable all the way to the screen.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Shared guard
-- ----------------------------------------------------------------------------
-- Every analytics function scopes to orders the caller can actually see. RLS
-- does the enforcing; this view keeps the definition of "counted revenue" in
-- exactly one place so the modules cannot drift apart.

create or replace function public.analytics_counted_orders(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  id          uuid,
  channel_id  uuid,
  customer_id uuid,
  total       numeric,
  fee_total   numeric,
  placed_at   timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id, o.channel_id, o.customer_id, o.total, o.fee_total, o.placed_at
  from public.orders o
  where o.business_id = p_business_id
    and o.placed_at >= p_from
    and o.placed_at <  p_to
    and o.status <> 'CANCELLED';
$$;


-- ----------------------------------------------------------------------------
-- 2. analytics_financials -- the headline set
-- ----------------------------------------------------------------------------

create or replace function public.analytics_financials(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  revenue                numeric,
  cogs                   numeric,
  fees                   numeric,
  gross_profit           numeric,
  gross_margin           numeric,
  expenses               numeric,
  net_profit             numeric,
  net_margin             numeric,
  orders_count           bigint,
  units_sold             numeric,
  avg_order_value        numeric,
  customers_count        bigint,
  refunds                numeric,
  returns_count          bigint,
  cancelled_orders       bigint,
  items_total            bigint,
  items_with_cost        bigint,
  cost_coverage          numeric,
  orders_zero_fees       bigint,
  orders_without_channel bigint,
  line_revenue           numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
),
lines as (
  select
    oi.quantity,
    oi.unit_cost,
    oi.line_total,
    coalesce(oi.quantity * oi.unit_cost, 0) as line_cost,
    (oi.unit_cost is not null)              as has_cost
  from public.order_items oi
  join counted c on c.id = oi.order_id
),
base as (
  select
    coalesce((select sum(total) from counted), 0)                       as revenue,
    coalesce((select sum(fee_total) from counted), 0)                   as fees,
    coalesce((select count(*) from counted), 0)                         as orders_count,
    coalesce((select count(distinct customer_id) from counted
               where customer_id is not null), 0)                       as customers_count,
    coalesce((select count(*) from counted where fee_total = 0), 0)     as orders_zero_fees,
    coalesce((select count(*) from counted where channel_id is null), 0) as orders_without_channel,
    coalesce((select sum(quantity) from lines), 0)                      as units_sold,
    coalesce((select sum(line_cost) from lines), 0)                     as cogs,
    coalesce((select sum(line_total) from lines), 0)                    as line_revenue,
    coalesce((select count(*) from lines), 0)                           as items_total,
    coalesce((select count(*) filter (where has_cost) from lines), 0)   as items_with_cost,
    coalesce((select sum(e.amount) from public.expenses e
               where e.business_id = p_business_id
                 and e.incurred_at >= p_from and e.incurred_at < p_to), 0) as expenses,
    coalesce((select sum(r.refund_amount) from public.returns r
               where r.business_id = p_business_id
                 and r.occurred_at >= p_from and r.occurred_at < p_to
                 and r.status in ('REFUNDED','RECEIVED','APPROVED')), 0)   as refunds,
    coalesce((select count(*) from public.returns r
               where r.business_id = p_business_id
                 and r.occurred_at >= p_from and r.occurred_at < p_to), 0) as returns_count,
    coalesce((select count(*) from public.orders o
               where o.business_id = p_business_id
                 and o.placed_at >= p_from and o.placed_at < p_to
                 and o.status = 'CANCELLED'), 0)                        as cancelled_orders
)
select
  b.revenue,
  b.cogs,
  b.fees,
  (b.revenue - b.cogs - b.fees)                                as gross_profit,
  case when b.revenue > 0
       then round(((b.revenue - b.cogs - b.fees) / b.revenue) * 100, 2) end
                                                               as gross_margin,
  b.expenses,
  (b.revenue - b.cogs - b.fees - b.expenses)                   as net_profit,
  case when b.revenue > 0
       then round(((b.revenue - b.cogs - b.fees - b.expenses) / b.revenue) * 100, 2) end
                                                               as net_margin,
  b.orders_count,
  b.units_sold,
  case when b.orders_count > 0 then round(b.revenue / b.orders_count, 2) end
                                                               as avg_order_value,
  b.customers_count,
  b.refunds,
  b.returns_count,
  b.cancelled_orders,
  b.items_total,
  b.items_with_cost,
  case when b.items_total > 0
       then round((b.items_with_cost::numeric / b.items_total) * 100, 2) end
                                                               as cost_coverage,
  b.orders_zero_fees,
  b.orders_without_channel,
  b.line_revenue
from base b;
$$;


-- ----------------------------------------------------------------------------
-- 3. analytics_compare -- period over period
-- ----------------------------------------------------------------------------
-- Returns one row per metric so the caller never performs arithmetic.
--
-- Edge cases, all deliberate:
--   previous = 0        percent_change NULL. "Up from nothing" has no
--                       percentage; rendering infinity or +100% would invent a
--                       figure. direction is 'up' when the current value is
--                       positive, 'flat' when both are zero.
--   either value NULL   both change columns NULL, direction 'unknown'. A
--                       margin that cannot be calculated has no trend.
--   both zero           change 0, percent NULL, direction 'flat'.
--
-- `direction` describes the NUMBER only. Whether up is good depends on the
-- metric and is decided in the service layer.

create or replace function public.analytics_compare(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  metric          text,
  current_value   numeric,
  previous_value  numeric,
  absolute_change numeric,
  percent_change  numeric,
  direction       text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur as (select * from public.analytics_financials(p_business_id, p_from, p_to)),
prev as (select * from public.analytics_financials(p_business_id, p_prev_from, p_prev_to)),
pairs as (
  select 'revenue'::text        as metric, c.revenue        as cv, p.revenue        as pv from cur c, prev p
  union all select 'cogs',            c.cogs,            p.cogs            from cur c, prev p
  union all select 'fees',            c.fees,            p.fees            from cur c, prev p
  union all select 'gross_profit',    c.gross_profit,    p.gross_profit    from cur c, prev p
  union all select 'gross_margin',    c.gross_margin,    p.gross_margin    from cur c, prev p
  union all select 'expenses',        c.expenses,        p.expenses        from cur c, prev p
  union all select 'net_profit',      c.net_profit,      p.net_profit      from cur c, prev p
  union all select 'net_margin',      c.net_margin,      p.net_margin      from cur c, prev p
  union all select 'orders_count',    c.orders_count,    p.orders_count    from cur c, prev p
  union all select 'units_sold',      c.units_sold,      p.units_sold      from cur c, prev p
  union all select 'avg_order_value', c.avg_order_value, p.avg_order_value from cur c, prev p
  union all select 'customers_count', c.customers_count, p.customers_count from cur c, prev p
  union all select 'refunds',         c.refunds,         p.refunds         from cur c, prev p
  union all select 'cost_coverage',   c.cost_coverage,   p.cost_coverage   from cur c, prev p
)
select
  pairs.metric,
  pairs.cv,
  pairs.pv,
  case when pairs.cv is null or pairs.pv is null then null
       else pairs.cv - pairs.pv end                                   as absolute_change,
  case when pairs.cv is null or pairs.pv is null then null
       when pairs.pv = 0 then null
       else round(((pairs.cv - pairs.pv) / abs(pairs.pv)) * 100, 2) end as percent_change,
  case when pairs.cv is null or pairs.pv is null then 'unknown'
       when pairs.cv > pairs.pv then 'up'
       when pairs.cv < pairs.pv then 'down'
       else 'flat' end                                                as direction
from pairs;
$$;


-- ----------------------------------------------------------------------------
-- 4. analytics_channels
-- ----------------------------------------------------------------------------
-- Every counted order belongs to exactly one channel, or to none. Orders with
-- no channel are grouped as "Unattributed" rather than dropped, so channel
-- revenue ALWAYS sums to total revenue exactly. That reconciliation is
-- asserted by the test suite.

create or replace function public.analytics_channels(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  channel_id      uuid,
  channel_name    text,
  channel_type    public.channel_type,
  revenue         numeric,
  cogs            numeric,
  fees            numeric,
  gross_profit    numeric,
  gross_margin    numeric,
  orders_count    bigint,
  units_sold      numeric,
  avg_order_value numeric,
  items_total     bigint,
  items_with_cost bigint,
  cost_coverage   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
),
line_agg as (
  select
    c.channel_id,
    sum(coalesce(oi.quantity * oi.unit_cost, 0))          as cogs,
    sum(oi.quantity)                                     as units_sold,
    count(*)                                             as items_total,
    count(*) filter (where oi.unit_cost is not null)      as items_with_cost
  from public.order_items oi
  join counted c on c.id = oi.order_id
  group by c.channel_id
),
order_agg as (
  select
    c.channel_id,
    sum(c.total)     as revenue,
    sum(c.fee_total) as fees,
    count(*)         as orders_count
  from counted c
  group by c.channel_id
)
select
  o.channel_id,
  coalesce(ch.name, 'Unattributed')                        as channel_name,
  coalesce(ch.type, 'OTHER'::public.channel_type)          as channel_type,
  o.revenue,
  coalesce(l.cogs, 0)                                      as cogs,
  o.fees,
  (o.revenue - coalesce(l.cogs, 0) - o.fees)               as gross_profit,
  case when o.revenue > 0
       then round(((o.revenue - coalesce(l.cogs, 0) - o.fees) / o.revenue) * 100, 2) end
                                                           as gross_margin,
  o.orders_count,
  coalesce(l.units_sold, 0)                                as units_sold,
  case when o.orders_count > 0 then round(o.revenue / o.orders_count, 2) end
                                                           as avg_order_value,
  coalesce(l.items_total, 0)                               as items_total,
  coalesce(l.items_with_cost, 0)                           as items_with_cost,
  case when coalesce(l.items_total, 0) > 0
       then round((l.items_with_cost::numeric / l.items_total) * 100, 2) end
                                                           as cost_coverage
from order_agg o
left join line_agg l on l.channel_id is not distinct from o.channel_id
left join public.channels ch on ch.id = o.channel_id
order by o.revenue desc;
$$;


-- ----------------------------------------------------------------------------
-- 5. analytics_products
-- ----------------------------------------------------------------------------
-- IMPORTANT, AND DOCUMENTED RATHER THAN HIDDEN:
--
-- Product revenue is LINE revenue -- the sum of order-line totals. It does not
-- include shipping or order-level discounts, which belong to an order and not
-- to any one product. Product revenue therefore does NOT sum to overall
-- revenue, and it is not a bug. analytics_reconciliation() reports the gap.
--
-- `fees_allocated` is an ALLOCATION, not a measurement. Fees are charged per
-- order; splitting them across lines in proportion to line revenue is a choice
-- this engine makes explicit in the column name so it can never be mistaken
-- for a figure someone actually charged.

create or replace function public.analytics_products(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_limit       integer default 100
)
returns table (
  sku             text,
  product_name    text,
  revenue         numeric,
  units_sold      numeric,
  cogs            numeric,
  fees_allocated  numeric,
  gross_profit    numeric,
  gross_margin    numeric,
  orders_count    bigint,
  items_total     bigint,
  items_with_cost bigint,
  cost_coverage   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
),
order_line_totals as (
  select oi.order_id, sum(oi.line_total) as order_line_total
  from public.order_items oi
  join counted c on c.id = oi.order_id
  group by oi.order_id
),
lines as (
  select
    coalesce(oi.sku, '(no SKU)')                     as sku,
    coalesce(oi.name, '(unnamed)')                   as product_name,
    oi.order_id,
    oi.quantity,
    oi.line_total,
    coalesce(oi.quantity * oi.unit_cost, 0)          as line_cost,
    (oi.unit_cost is not null)                       as has_cost,
    -- Pro-rata share of the order's fees, by line revenue. Zero when the
    -- order has no line revenue to apportion against.
    case when olt.order_line_total > 0
         then c.fee_total * (oi.line_total / olt.order_line_total)
         else 0 end                                  as fee_share
  from public.order_items oi
  join counted c on c.id = oi.order_id
  join order_line_totals olt on olt.order_id = oi.order_id
)
select
  l.sku,
  min(l.product_name)                                       as product_name,
  sum(l.line_total)                                         as revenue,
  sum(l.quantity)                                           as units_sold,
  sum(l.line_cost)                                          as cogs,
  round(sum(l.fee_share), 4)                                as fees_allocated,
  (sum(l.line_total) - sum(l.line_cost) - round(sum(l.fee_share), 4))
                                                            as gross_profit,
  case when sum(l.line_total) > 0
       then round((((sum(l.line_total) - sum(l.line_cost) - round(sum(l.fee_share), 4))
                    / sum(l.line_total)) * 100), 2) end     as gross_margin,
  count(distinct l.order_id)                                as orders_count,
  count(*)                                                  as items_total,
  count(*) filter (where l.has_cost)                        as items_with_cost,
  case when count(*) > 0
       then round((count(*) filter (where l.has_cost))::numeric / count(*) * 100, 2) end
                                                            as cost_coverage
from lines l
group by l.sku
order by sum(l.line_total) desc
limit greatest(p_limit, 1);
$$;


-- ----------------------------------------------------------------------------
-- 6. analytics_reconciliation
-- ----------------------------------------------------------------------------
-- Makes the relationship between order revenue and line revenue visible
-- instead of leaving it as a discrepancy someone discovers later.

create or replace function public.analytics_reconciliation(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  order_revenue        numeric,
  channel_revenue      numeric,
  channel_difference   numeric,
  line_revenue         numeric,
  order_line_gap       numeric,
  orders_without_lines bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with f as (select * from public.analytics_financials(p_business_id, p_from, p_to)),
ch as (
  select coalesce(sum(revenue), 0) as channel_revenue
  from public.analytics_channels(p_business_id, p_from, p_to)
),
counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
)
select
  f.revenue                                                     as order_revenue,
  ch.channel_revenue,
  (f.revenue - ch.channel_revenue)                              as channel_difference,
  f.line_revenue,
  -- Shipping, order-level discounts and orders with no lines all land here.
  (f.revenue - f.line_revenue)                                  as order_line_gap,
  (select count(*) from counted c
    where not exists (select 1 from public.order_items oi where oi.order_id = c.id))
                                                                as orders_without_lines
from f, ch;
$$;


-- ----------------------------------------------------------------------------
-- 7. analytics_health_inputs
-- ----------------------------------------------------------------------------
-- Raw, verified inputs for the Business Health Score. Scoring thresholds live
-- in the service layer where they can be read and argued with; this function
-- only measures.
--
-- A dimension with no data returns NULL so the score can say "not enough
-- information" rather than assume a value.

create or replace function public.analytics_health_inputs(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  revenue                numeric,
  revenue_previous       numeric,
  revenue_growth_pct     numeric,
  gross_margin           numeric,
  net_margin             numeric,
  cost_coverage          numeric,
  refund_rate            numeric,
  expense_ratio          numeric,
  orders_count           bigint,
  customers_count        bigint,
  repeat_customer_rate   numeric,
  cancelled_rate         numeric,
  orders_without_channel bigint,
  orders_zero_fees       bigint,
  variants_tracked       bigint,
  variants_out_of_stock  bigint,
  variants_below_reorder bigint,
  paid_order_value       numeric,
  unpaid_order_value     numeric,
  payment_capture_rate   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur  as (select * from public.analytics_financials(p_business_id, p_from, p_to)),
prev as (select * from public.analytics_financials(p_business_id, p_prev_from, p_prev_to)),
counted as (select * from public.analytics_counted_orders(p_business_id, p_from, p_to)),
repeat_buyers as (
  select count(*) as repeat_count
  from (
    select customer_id
    from counted
    where customer_id is not null
    group by customer_id
    having count(*) > 1
  ) r
),
stock as (
  select
    count(*)                                                        as tracked,
    count(*) filter (where i.quantity_on_hand <= 0)                 as out_of_stock,
    count(*) filter (where i.reorder_point is not null
                       and i.quantity_on_hand <= i.reorder_point)   as below_reorder
  from public.inventory i
  where i.business_id = p_business_id
),
payments as (
  select
    coalesce(sum(p.amount) filter (where p.status = 'PAID'), 0)     as paid_value,
    coalesce(sum(p.amount) filter (where p.status in ('PENDING','FAILED')), 0) as unpaid_value
  from public.payments p
  where p.business_id = p_business_id
    and coalesce(p.paid_at, p.created_at) >= p_from
    and coalesce(p.paid_at, p.created_at) <  p_to
)
select
  cur.revenue,
  prev.revenue                                                       as revenue_previous,
  case when prev.revenue > 0
       then round(((cur.revenue - prev.revenue) / prev.revenue) * 100, 2) end
                                                                     as revenue_growth_pct,
  cur.gross_margin,
  cur.net_margin,
  cur.cost_coverage,
  case when cur.revenue > 0 then round((cur.refunds / cur.revenue) * 100, 2) end
                                                                     as refund_rate,
  case when cur.revenue > 0 then round((cur.expenses / cur.revenue) * 100, 2) end
                                                                     as expense_ratio,
  cur.orders_count,
  cur.customers_count,
  case when cur.customers_count > 0
       then round((rb.repeat_count::numeric / cur.customers_count) * 100, 2) end
                                                                     as repeat_customer_rate,
  case when (cur.orders_count + cur.cancelled_orders) > 0
       then round((cur.cancelled_orders::numeric
                   / (cur.orders_count + cur.cancelled_orders)) * 100, 2) end
                                                                     as cancelled_rate,
  cur.orders_without_channel,
  cur.orders_zero_fees,
  st.tracked                                                         as variants_tracked,
  st.out_of_stock                                                    as variants_out_of_stock,
  st.below_reorder                                                   as variants_below_reorder,
  pm.paid_value                                                      as paid_order_value,
  pm.unpaid_value                                                    as unpaid_order_value,
  case when (pm.paid_value + pm.unpaid_value) > 0
       then round((pm.paid_value / (pm.paid_value + pm.unpaid_value)) * 100, 2) end
                                                                     as payment_capture_rate
from cur, prev, repeat_buyers rb, stock st, payments pm;
$$;


-- ----------------------------------------------------------------------------
-- 8. Privileges
-- ----------------------------------------------------------------------------

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.analytics_counted_orders(uuid, timestamptz, timestamptz)',
    'public.analytics_financials(uuid, timestamptz, timestamptz)',
    'public.analytics_compare(uuid, timestamptz, timestamptz, timestamptz, timestamptz)',
    'public.analytics_channels(uuid, timestamptz, timestamptz)',
    'public.analytics_products(uuid, timestamptz, timestamptz, integer)',
    'public.analytics_reconciliation(uuid, timestamptz, timestamptz)',
    'public.analytics_health_inputs(uuid, timestamptz, timestamptz, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', sig);
    execute format('grant execute on function %s to authenticated', sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_missing text[] := '{}';
  fn        text;
begin
  foreach fn in array array[
    'analytics_counted_orders', 'analytics_financials', 'analytics_compare',
    'analytics_channels', 'analytics_products', 'analytics_reconciliation',
    'analytics_health_inputs'
  ]
  loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
    ) then
      v_missing := v_missing || fn;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'Analytics functions missing: %', array_to_string(v_missing, ', ');
  end if;

  -- Guard the historical-cost rule established in migration 0005. If an
  -- analytics function ever reaches for a catalogue cost, profit stops being
  -- reproducible and this migration must fail.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'analytics!_%' escape '!'
      and p.prosrc ~* 'product_variants'
  ) then
    raise exception
      'SAFETY: an analytics function references product_variants. Profit must '
      'use the historical cost on the order line only.';
  end if;

  raise notice 'Migration 0007 verified: 7 analytics functions installed, historical-cost rule intact.';
end;
$$;


commit;
