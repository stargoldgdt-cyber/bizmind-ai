-- ============================================================================
-- 0025  Analytics foundation
-- ============================================================================
-- Four changes to the same few functions, made once, together:
--
--   1. CHANNEL IS A DIMENSION. The base set of counted orders takes an
--      optional channel -- one channel, or "orders with no channel" -- and
--      every figure built on it follows. A dashboard filtered to Amazon shows
--      Amazon's revenue, cost, fees, margin, products and trend, computed here,
--      not filtered in a browser.
--
--      EXPENSES ARE WHOLE-BUSINESS. BizMind has no per-channel expense data, so
--      under a channel filter expenses, net profit and net margin come back
--      NULL -- never an invented allocation. The dashboard shows the
--      whole-business net profit separately, labelled as such.
--
--   2. WITHDRAWN RECORDS STOP COUNTING. Migration 0024 added the markers;
--      nothing sets them yet. Every reader now excludes withdrawn orders,
--      expenses and products, so withdrawal works the moment it exists.
--
--   3. PRODUCTS ARE IDENTIFIED HONESTLY. Grouped by SKU, then by product name;
--      lines with neither form one row that says so. Named from the product
--      catalogue first, then the order line, then the SKU. The old
--      "(unnamed)" label and the single "(no SKU)" bucket that merged unrelated
--      products are gone. Where the name came from is returned alongside it.
--
--   4. A BLANK LINE TOTAL IS NOT ZERO. When the source gave a unit price but no
--      line total, the line's value is CALCULATED here as quantity x unit
--      price, and reported separately so it is never presented as a figure the
--      source supplied. The stored order line is not changed. A line with
--      neither is left OUT of line revenue -- previously it counted as zero,
--      which showed products with cost but no revenue. Revenue (order totals),
--      cost of goods and channel figures are unaffected.
--
-- Every figure that does not involve a channel filter or a blank line total
-- is calculated exactly as before; the live suites hold it to that.
--
-- Depends on 0001-0024. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The base set of counted orders
-- ----------------------------------------------------------------------------
-- A new signature, so the old one is dropped first: two overloads would make
-- every call by name ambiguous. Callers passing three arguments still work --
-- the new parameters have defaults.

drop function public.analytics_counted_orders(uuid, timestamptz, timestamptz);

create function public.analytics_counted_orders(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
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
    and o.status <> 'CANCELLED'
    and o.withdrawn_at is null
    and case
          when p_no_channel             then o.channel_id is null
          when p_channel_id is not null then o.channel_id = p_channel_id
          else true
        end;
$$;


-- ----------------------------------------------------------------------------
-- 2. Core financials
-- ----------------------------------------------------------------------------
-- Every column the 0010 version returned is calculated the same way. Added:
-- the calculated share of line revenue, the counts behind it, and whether the
-- figures are channel-scoped.

drop function analytics_core.analytics_financials(uuid, timestamptz, timestamptz);

create function analytics_core.analytics_financials(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
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
  cost_gap               numeric,
  orders_zero_fees       bigint,
  orders_without_channel bigint,
  line_revenue           numeric,
  orders_fees_unknown    bigint,
  fee_coverage           numeric,
  fee_gap                numeric,
  line_revenue_derived   numeric,
  items_value_derived    bigint,
  items_value_unknown    bigint,
  channel_scoped         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)
),
lines as (
  select
    oi.quantity,
    coalesce(oi.quantity * oi.unit_cost, 0)                     as line_cost,
    (oi.unit_cost is not null)                                   as has_cost,
    -- The source's line total when it gave one; otherwise quantity x unit
    -- price, CALCULATED; otherwise unknown.
    case when oi.line_total is not null then oi.line_total
         when oi.unit_price is not null then oi.quantity * oi.unit_price
    end                                                          as line_value,
    (oi.line_total is null and oi.unit_price is not null)        as value_derived
  from public.order_items oi
  join counted c on c.id = oi.order_id
),
returns_in_scope as (
  select r.refund_amount, r.status
  from public.returns r
  left join public.orders o on o.id = r.order_id
  where r.business_id = p_business_id
    and r.occurred_at >= p_from
    and r.occurred_at <  p_to
    and (o.id is null or o.withdrawn_at is null)
    and case
          when p_no_channel             then o.channel_id is null
          when p_channel_id is not null then o.channel_id = p_channel_id
          else true
        end
),
base as (
  select
    coalesce((select sum(total) from counted), 0)                          as revenue,
    coalesce((select sum(coalesce(fee_total, 0)) from counted), 0)         as fees,
    coalesce((select count(*) from counted), 0)                            as orders_count,
    coalesce((select count(distinct customer_id) from counted
               where customer_id is not null), 0)                          as customers_count,
    coalesce((select count(*) from counted where fee_total = 0), 0)        as orders_zero_fees,
    coalesce((select count(*) from counted where fee_total is null), 0)    as orders_fees_unknown,
    coalesce((select count(*) from counted where channel_id is null), 0)   as orders_without_channel,
    coalesce((select sum(quantity) from lines), 0)                         as units_sold,
    coalesce((select sum(line_cost) from lines), 0)                        as cogs,
    coalesce((select sum(line_value) from lines), 0)                       as line_revenue,
    coalesce((select sum(line_value) filter (where value_derived) from lines), 0)
                                                                           as line_revenue_derived,
    coalesce((select count(*) filter (where value_derived) from lines), 0) as items_value_derived,
    coalesce((select count(*) filter (where line_value is null) from lines), 0)
                                                                           as items_value_unknown,
    coalesce((select count(*) from lines), 0)                              as items_total,
    coalesce((select count(*) filter (where has_cost) from lines), 0)      as items_with_cost,
    (p_no_channel or p_channel_id is not null)                             as channel_scoped,
    coalesce((select sum(e.amount) from public.expenses e
               where e.business_id = p_business_id
                 and e.incurred_at >= p_from and e.incurred_at < p_to
                 and e.withdrawn_at is null), 0)                           as business_expenses,
    coalesce((select sum(r.refund_amount) from returns_in_scope r
               where r.status in ('REFUNDED','RECEIVED','APPROVED')), 0)   as refunds,
    coalesce((select count(*) from returns_in_scope), 0)                   as returns_count,
    coalesce((select count(*) from public.orders o
               where o.business_id = p_business_id
                 and o.placed_at >= p_from and o.placed_at < p_to
                 and o.status = 'CANCELLED'
                 and o.withdrawn_at is null
                 and case
                       when p_no_channel             then o.channel_id is null
                       when p_channel_id is not null then o.channel_id = p_channel_id
                       else true
                     end), 0)                                              as cancelled_orders
)
select
  b.revenue,
  b.cogs,
  b.fees,
  (b.revenue - b.cogs - b.fees)                                            as gross_profit,
  case when b.revenue > 0
       then round(((b.revenue - b.cogs - b.fees) / b.revenue) * 100, 2) end
                                                                           as gross_margin,
  -- Whole-business figures. Under a channel filter they are NULL: there is no
  -- per-channel expense data, and spreading expenses across channels would be
  -- inventing an allocation.
  case when b.channel_scoped then null else b.business_expenses end        as expenses,
  case when b.channel_scoped then null
       else (b.revenue - b.cogs - b.fees - b.business_expenses) end        as net_profit,
  case when b.channel_scoped or b.revenue <= 0 then null
       else round(((b.revenue - b.cogs - b.fees - b.business_expenses) / b.revenue) * 100, 2)
  end                                                                      as net_margin,
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
  case when b.items_total > 0
       then round(((b.items_total - b.items_with_cost)::numeric / b.items_total) * 100, 2) end
                                                                           as cost_gap,
  b.orders_zero_fees,
  b.orders_without_channel,
  b.line_revenue,
  b.orders_fees_unknown,
  case when b.orders_count > 0
       then round(((b.orders_count - b.orders_fees_unknown)::numeric / b.orders_count) * 100, 2) end
                                                                           as fee_coverage,
  case when b.orders_count > 0
       then round((b.orders_fees_unknown::numeric / b.orders_count) * 100, 2) end
                                                                           as fee_gap,
  b.line_revenue_derived,
  b.items_value_derived,
  b.items_value_unknown,
  b.channel_scoped
from base b;
$$;


-- ----------------------------------------------------------------------------
-- 3. Core channels
-- ----------------------------------------------------------------------------
-- Calculated exactly as in 0008. A channel filter returns that channel's row.

drop function analytics_core.analytics_channels(uuid, timestamptz, timestamptz);

create function analytics_core.analytics_channels(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  channel_id          uuid,
  channel_name        text,
  channel_type        public.channel_type,
  revenue             numeric,
  cogs                numeric,
  fees                numeric,
  gross_profit        numeric,
  gross_margin        numeric,
  orders_count        bigint,
  units_sold          numeric,
  avg_order_value     numeric,
  items_total         bigint,
  items_with_cost     bigint,
  cost_coverage       numeric,
  orders_fees_unknown bigint,
  fee_coverage        numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)
),
line_agg as (
  select
    c.channel_id,
    sum(coalesce(oi.quantity * oi.unit_cost, 0))              as cogs,
    sum(oi.quantity)                                          as units_sold,
    count(*)                                                  as items_total,
    count(*) filter (where oi.unit_cost is not null)           as items_with_cost
  from public.order_items oi
  join counted c on c.id = oi.order_id
  group by c.channel_id
),
order_agg as (
  select
    c.channel_id,
    sum(c.total)                                     as revenue,
    sum(coalesce(c.fee_total, 0))                    as fees,
    count(*)                                         as orders_count,
    count(*) filter (where c.fee_total is null)      as fees_unknown
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
                                                           as cost_coverage,
  o.fees_unknown                                           as orders_fees_unknown,
  case when o.orders_count > 0
       then round(((o.orders_count - o.fees_unknown)::numeric / o.orders_count) * 100, 2) end
                                                           as fee_coverage
from order_agg o
left join line_agg l on l.channel_id is not distinct from o.channel_id
left join public.channels ch on ch.id = o.channel_id
order by o.revenue desc;
$$;


-- ----------------------------------------------------------------------------
-- 4. Core products: identified honestly, blank line totals handled
-- ----------------------------------------------------------------------------
-- Revenue, cost, fees and profit are measured over the lines whose value is
-- KNOWN (supplied, or calculated as quantity x unit price). A line with no
-- known value is counted in items_value_unknown and left out of the profit
-- calculation entirely: counting its cost against no revenue is what showed
-- products "with cost but no revenue". For a product where every line is
-- unknown, revenue and profit are NULL -- never zero.
--
-- Fees are shared across an order's lines in proportion to their known value,
-- as before. For a business whose lines all carry a line total, every figure
-- is exactly what 0008 produced.

drop function analytics_core.analytics_products(uuid, timestamptz, timestamptz, integer);

create function analytics_core.analytics_products(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_limit       integer default 100,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  product_key         text,
  product_id          uuid,
  sku                 text,
  product_name        text,
  name_source         text,
  revenue             numeric,
  revenue_derived     numeric,
  units_sold          numeric,
  cogs                numeric,
  fees_allocated      numeric,
  gross_profit        numeric,
  gross_margin        numeric,
  orders_count        bigint,
  items_total         bigint,
  items_measured      bigint,
  items_value_derived bigint,
  items_value_unknown bigint,
  items_with_cost     bigint,
  cost_coverage       numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)
),
lines as (
  select
    oi.order_id,
    oi.product_id,
    nullif(trim(oi.sku), '')                                     as sku,
    nullif(trim(oi.name), '')                                    as line_name,
    oi.quantity,
    oi.unit_cost,
    case when oi.line_total is not null then oi.line_total
         when oi.unit_price is not null then oi.quantity * oi.unit_price
    end                                                          as line_value,
    (oi.line_total is null and oi.unit_price is not null)        as value_derived,
    c.fee_total
  from public.order_items oi
  join counted c on c.id = oi.order_id
),
keyed as (
  select
    l.*,
    case
      when l.sku is not null        then 'sku:' || l.sku
      when l.product_id is not null then 'product:' || l.product_id::text
      when l.line_name is not null  then 'name:' || lower(l.line_name)
      else 'unidentified'
    end                                                          as product_key
  from lines l
),
order_value as (
  select order_id, sum(line_value) as known_value
  from keyed
  group by order_id
),
shared as (
  select
    k.*,
    (k.line_value is not null)                                   as measured,
    case when k.line_value is not null and ov.known_value > 0
         then coalesce(k.fee_total, 0) * (k.line_value / ov.known_value)
         else 0 end                                              as fee_share
  from keyed k
  join order_value ov on ov.order_id = k.order_id
),
grouped as (
  select
    s.product_key,
    (array_agg(s.product_id) filter (where s.product_id is not null))[1]        as product_id,
    (array_agg(s.sku order by s.sku) filter (where s.sku is not null))[1]       as sku,
    mode() within group (order by s.line_name) filter (where s.line_name is not null)
                                                                                as line_name,
    sum(s.line_value) filter (where s.measured)                                 as revenue,
    coalesce(sum(s.line_value) filter (where s.measured and s.value_derived), 0) as revenue_derived,
    sum(s.quantity)                                                             as units_sold,
    coalesce(sum(coalesce(s.quantity * s.unit_cost, 0)) filter (where s.measured), 0)
                                                                                as cogs,
    round(coalesce(sum(s.fee_share) filter (where s.measured), 0), 4)           as fees_allocated,
    count(distinct s.order_id)                                                  as orders_count,
    count(*)                                                                    as items_total,
    count(*) filter (where s.measured)                                          as items_measured,
    count(*) filter (where s.value_derived)                                     as items_value_derived,
    count(*) filter (where not s.measured)                                      as items_value_unknown,
    count(*) filter (where s.measured and s.unit_cost is not null)              as items_with_cost
  from shared s
  group by s.product_key
)
select
  g.product_key,
  coalesce(g.product_id, p.id)                                               as product_id,
  g.sku,
  coalesce(p.name, g.line_name, g.sku, 'Lines with no product identity')     as product_name,
  case when p.name is not null      then 'CATALOGUE'
       when g.line_name is not null then 'ORDER_LINE'
       when g.sku is not null       then 'SKU'
       else 'NONE' end                                                       as name_source,
  g.revenue,
  g.revenue_derived,
  g.units_sold,
  g.cogs,
  g.fees_allocated,
  case when g.revenue is not null then g.revenue - g.cogs - g.fees_allocated end
                                                                             as gross_profit,
  case when g.revenue > 0
       then round(((g.revenue - g.cogs - g.fees_allocated) / g.revenue) * 100, 2) end
                                                                             as gross_margin,
  g.orders_count,
  g.items_total,
  g.items_measured,
  g.items_value_derived,
  g.items_value_unknown,
  g.items_with_cost,
  case when g.items_measured > 0
       then round((g.items_with_cost::numeric / g.items_measured) * 100, 2) end
                                                                             as cost_coverage
from grouped g
left join public.products p
  on p.business_id = p_business_id
 and p.withdrawn_at is null
 and (p.id = g.product_id
      or (g.product_id is null and g.sku is not null and p.sku = g.sku))
order by g.revenue desc nulls last, g.product_key
limit greatest(p_limit, 1);
$$;


-- ----------------------------------------------------------------------------
-- 5. Public wrappers: exact text, the channel passed through
-- ----------------------------------------------------------------------------

drop function public.analytics_financials(uuid, timestamptz, timestamptz);
drop function public.analytics_channels(uuid, timestamptz, timestamptz);
drop function public.analytics_products(uuid, timestamptz, timestamptz, integer);
drop function public.analytics_compare(uuid, timestamptz, timestamptz, timestamptz, timestamptz);
drop function public.analytics_reconciliation(uuid, timestamptz, timestamptz);


create function public.analytics_financials(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  revenue                text,
  cogs                   text,
  fees                   text,
  gross_profit           text,
  gross_margin           text,
  expenses               text,
  net_profit             text,
  net_margin             text,
  orders_count           bigint,
  units_sold             text,
  avg_order_value        text,
  customers_count        bigint,
  refunds                text,
  returns_count          bigint,
  cancelled_orders       bigint,
  items_total            bigint,
  items_with_cost        bigint,
  cost_coverage          text,
  cost_gap               text,
  orders_zero_fees       bigint,
  orders_without_channel bigint,
  line_revenue           text,
  orders_fees_unknown    bigint,
  fee_coverage           text,
  fee_gap                text,
  refund_rate            text,
  line_revenue_derived   text,
  items_value_derived    bigint,
  items_value_unknown    bigint,
  channel_scoped         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.revenue::text,
    q.cogs::text,
    q.fees::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.expenses::text,
    q.net_profit::text,
    q.net_margin::text,
    q.orders_count,
    q.units_sold::text,
    q.avg_order_value::text,
    q.customers_count,
    q.refunds::text,
    q.returns_count,
    q.cancelled_orders,
    q.items_total,
    q.items_with_cost,
    q.cost_coverage::text,
    q.cost_gap::text,
    q.orders_zero_fees,
    q.orders_without_channel,
    q.line_revenue::text,
    q.orders_fees_unknown,
    q.fee_coverage::text,
    q.fee_gap::text,
    (case when q.revenue > 0
          then round((q.refunds / q.revenue) * 100, 2) end)::text as refund_rate,
    q.line_revenue_derived::text,
    q.items_value_derived,
    q.items_value_unknown,
    q.channel_scoped
  from analytics_core.analytics_financials(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel) q;
$$;


create function public.analytics_channels(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  channel_id          uuid,
  channel_name        text,
  channel_type        public.channel_type,
  revenue             text,
  cogs                text,
  fees                text,
  gross_profit        text,
  gross_margin        text,
  orders_count        bigint,
  units_sold          text,
  avg_order_value     text,
  items_total         bigint,
  items_with_cost     bigint,
  cost_coverage       text,
  orders_fees_unknown bigint,
  fee_coverage        text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.channel_id,
    q.channel_name,
    q.channel_type,
    q.revenue::text,
    q.cogs::text,
    q.fees::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.orders_count,
    q.units_sold::text,
    q.avg_order_value::text,
    q.items_total,
    q.items_with_cost,
    q.cost_coverage::text,
    q.orders_fees_unknown,
    q.fee_coverage::text
  from analytics_core.analytics_channels(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel) q;
$$;


create function public.analytics_products(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_limit       integer default 100,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  product_key         text,
  product_id          uuid,
  sku                 text,
  product_name        text,
  name_source         text,
  revenue             text,
  revenue_derived     text,
  units_sold          text,
  cogs                text,
  fees_allocated      text,
  gross_profit        text,
  gross_margin        text,
  orders_count        bigint,
  items_total         bigint,
  items_measured      bigint,
  items_value_derived bigint,
  items_value_unknown bigint,
  items_with_cost     bigint,
  cost_coverage       text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.product_key,
    q.product_id,
    q.sku,
    q.product_name,
    q.name_source,
    q.revenue::text,
    q.revenue_derived::text,
    q.units_sold::text,
    q.cogs::text,
    q.fees_allocated::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.orders_count,
    q.items_total,
    q.items_measured,
    q.items_value_derived,
    q.items_value_unknown,
    q.items_with_cost,
    q.cost_coverage::text
  from analytics_core.analytics_products(
    p_business_id, p_from, p_to, p_limit, p_channel_id, p_no_channel) q;
$$;


create function public.analytics_compare(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  metric          text,
  current_value   text,
  previous_value  text,
  absolute_change text,
  percent_change  text,
  direction       text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur as (
  select * from analytics_core.analytics_financials(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)),
prev as (
  select * from analytics_core.analytics_financials(
    p_business_id, p_prev_from, p_prev_to, p_channel_id, p_no_channel)),
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
  pairs.cv::text,
  pairs.pv::text,
  (case when pairs.cv is null or pairs.pv is null then null
        else pairs.cv - pairs.pv end)::text                             as absolute_change,
  (case when pairs.cv is null or pairs.pv is null then null
        when pairs.pv = 0 then null
        else round(((pairs.cv - pairs.pv) / abs(pairs.pv)) * 100, 2) end)::text
                                                                        as percent_change,
  case when pairs.cv is null or pairs.pv is null then 'unknown'
       when pairs.cv > pairs.pv then 'up'
       when pairs.cv < pairs.pv then 'down'
       else 'flat' end                                                  as direction
from pairs;
$$;


create function public.analytics_reconciliation(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  order_revenue        text,
  channel_revenue      text,
  channel_difference   text,
  line_revenue         text,
  order_line_gap       text,
  orders_without_lines bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with f as (
  select * from analytics_core.analytics_financials(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)),
ch as (
  select coalesce(sum(revenue), 0) as channel_revenue
  from analytics_core.analytics_channels(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)
),
counted as (
  select * from public.analytics_counted_orders(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)
)
select
  f.revenue::text                                               as order_revenue,
  ch.channel_revenue::text,
  (f.revenue - ch.channel_revenue)::text                        as channel_difference,
  f.line_revenue::text,
  -- Shipping, order-level discounts, orders with no lines, and lines whose
  -- value is unknown all land here.
  (f.revenue - f.line_revenue)::text                            as order_line_gap,
  (select count(*) from counted c
    where not exists (select 1 from public.order_items oi where oi.order_id = c.id))
                                                                as orders_without_lines
from f, ch;
$$;


-- ----------------------------------------------------------------------------
-- 6. Health inputs: whole-business, withdrawn records excluded
-- ----------------------------------------------------------------------------
-- Same signature and columns as 0011, replaced in place. Business Health is a
-- whole-business view -- stock, payments and customers are not per channel --
-- so it takes no channel. Only the stock and payment reads change.

create or replace function public.analytics_health_inputs(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  revenue                text,
  revenue_previous       text,
  revenue_growth_pct     text,
  gross_margin           text,
  net_margin             text,
  cost_coverage          text,
  refund_rate            text,
  expense_ratio          text,
  orders_count           bigint,
  customers_count        bigint,
  repeat_customer_rate   text,
  cancelled_rate         text,
  orders_without_channel bigint,
  orders_zero_fees       bigint,
  variants_tracked       bigint,
  variants_out_of_stock  bigint,
  variants_below_reorder bigint,
  paid_order_value       text,
  unpaid_order_value     text,
  payment_capture_rate   text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur  as (
  select * from analytics_core.analytics_financials(p_business_id, p_from, p_to)),
prev as (
  select * from analytics_core.analytics_financials(p_business_id, p_prev_from, p_prev_to)),
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
  join public.product_variants v on v.id = i.variant_id
  join public.products pr on pr.id = v.product_id
  where i.business_id = p_business_id
    and pr.withdrawn_at is null
),
payments as (
  select
    coalesce(sum(p.amount) filter (where p.status = 'PAID'), 0)     as paid_value,
    coalesce(sum(p.amount) filter (where p.status in ('PENDING','FAILED')), 0) as unpaid_value
  from public.payments p
  left join public.orders o on o.id = p.order_id
  where p.business_id = p_business_id
    and coalesce(p.paid_at, p.created_at) >= p_from
    and coalesce(p.paid_at, p.created_at) <  p_to
    and (o.id is null or o.withdrawn_at is null)
)
select
  cur.revenue::text,
  prev.revenue::text                                                 as revenue_previous,
  (case when prev.revenue > 0
        then round(((cur.revenue - prev.revenue) / prev.revenue) * 100, 2) end)::text
                                                                     as revenue_growth_pct,
  cur.gross_margin::text,
  cur.net_margin::text,
  cur.cost_coverage::text,
  (case when cur.revenue > 0 then round((cur.refunds / cur.revenue) * 100, 2) end)::text
                                                                     as refund_rate,
  (case when cur.revenue > 0 then round((cur.expenses / cur.revenue) * 100, 2) end)::text
                                                                     as expense_ratio,
  cur.orders_count,
  cur.customers_count,
  (case when cur.customers_count > 0
        then round((rb.repeat_count::numeric / cur.customers_count) * 100, 2) end)::text
                                                                     as repeat_customer_rate,
  (case when (cur.orders_count + cur.cancelled_orders) > 0
        then round((cur.cancelled_orders::numeric
                    / (cur.orders_count + cur.cancelled_orders)) * 100, 2) end)::text
                                                                     as cancelled_rate,
  cur.orders_without_channel,
  cur.orders_zero_fees,
  st.tracked                                                         as variants_tracked,
  st.out_of_stock                                                    as variants_out_of_stock,
  st.below_reorder                                                   as variants_below_reorder,
  pm.paid_value::text                                                as paid_order_value,
  pm.unpaid_value::text                                              as unpaid_order_value,
  (case when (pm.paid_value + pm.unpaid_value) > 0
        then round((pm.paid_value / (pm.paid_value + pm.unpaid_value)) * 100, 2) end)::text
                                                                     as payment_capture_rate
from cur, prev, repeat_buyers rb, stock st, payments pm;
$$;


-- ----------------------------------------------------------------------------
-- 7. Privileges
-- ----------------------------------------------------------------------------
-- Dropping a function discards its grants. Every one is reissued, and section
-- 8 asserts it. The wrappers are SECURITY INVOKER, so the caller also needs
-- EXECUTE on the core functions -- and Row Level Security applies throughout.

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.analytics_counted_orders(uuid, timestamptz, timestamptz, uuid, boolean)',
    'analytics_core.analytics_financials(uuid, timestamptz, timestamptz, uuid, boolean)',
    'analytics_core.analytics_channels(uuid, timestamptz, timestamptz, uuid, boolean)',
    'analytics_core.analytics_products(uuid, timestamptz, timestamptz, integer, uuid, boolean)',
    'public.analytics_financials(uuid, timestamptz, timestamptz, uuid, boolean)',
    'public.analytics_channels(uuid, timestamptz, timestamptz, uuid, boolean)',
    'public.analytics_products(uuid, timestamptz, timestamptz, integer, uuid, boolean)',
    'public.analytics_compare(uuid, timestamptz, timestamptz, timestamptz, timestamptz, uuid, boolean)',
    'public.analytics_reconciliation(uuid, timestamptz, timestamptz, uuid, boolean)',
    'public.analytics_health_inputs(uuid, timestamptz, timestamptz, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', v_sig);
    execute format('grant execute on function %s to authenticated', v_sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_fn       text;
  v_count    integer;
  v_type     text;
  v_business uuid;
  v_channel  record;
  v_total    numeric;
  v_parts    numeric;
  v_part     numeric;
begin
  foreach v_fn in array array[
    'analytics_counted_orders', 'analytics_financials', 'analytics_channels',
    'analytics_products', 'analytics_compare', 'analytics_reconciliation',
    'analytics_health_inputs'
  ]
  loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_count <> 1 then
      raise exception 'public.%() exists % times; expected exactly once.', v_fn, v_count;
    end if;

    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: authenticated cannot execute public.%(). Its grant was lost.', v_fn;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute public.%().', v_fn;
    end if;
  end loop;

  -- Money must still cross the boundary as text.
  foreach v_fn in array array['analytics_financials', 'analytics_channels', 'analytics_products']
  loop
    select pg_get_function_result(p.oid) into v_type
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if position('numeric' in v_type) > 0 then
      raise exception 'public.%() returns a numeric column, so money would reach JavaScript as a double: %',
        v_fn, v_type;
    end if;
  end loop;

  -- THE CHANNEL DIMENSION ADDS UP. For existing businesses, the revenue of
  -- each channel, plus orders with no channel, is exactly the whole.
  for v_business in select id from public.businesses order by created_at limit 25 loop
    select q.revenue into v_total
    from analytics_core.analytics_financials(
      v_business, now() - interval '3650 days', now() + interval '1 day') q;

    select q.revenue into v_parts
    from analytics_core.analytics_financials(
      v_business, now() - interval '3650 days', now() + interval '1 day', null, true) q;

    for v_channel in select c.id from public.channels c where c.business_id = v_business loop
      select q.revenue into v_part
      from analytics_core.analytics_financials(
        v_business, now() - interval '3650 days', now() + interval '1 day', v_channel.id, false) q;
      v_parts := v_parts + v_part;
    end loop;

    if v_parts is distinct from v_total then
      raise exception 'Channel revenues (%) do not add up to the whole (%) for business %.',
        v_parts, v_total, v_business;
    end if;
  end loop;

  raise notice
    'Migration 0025 verified: every analytics figure takes a channel and adds '
    'up across channels, withdrawn records are excluded, money is still exact '
    'text, and every function has exactly one signature and its grant.';
end;
$$;


commit;
