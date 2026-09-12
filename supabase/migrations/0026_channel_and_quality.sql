-- ============================================================================
-- 0026  Channel comparison, what changed, and data quality
-- ============================================================================
-- Three read-only functions the dashboard needs, all computed in SQL because
-- every one of them produces a figure an owner will act on:
--
--   1. analytics_channel_compare()  each channel against the previous period,
--      with its share of revenue and of the profit the business actually made.
--   2. analytics_change_drivers()   what moved: which channels and products
--      account for the change in revenue and gross profit.
--   3. analytics_data_quality()     what is missing, counted -- cost, fees,
--      channel, customer, product identity, line value and date coverage --
--      plus analytics_quality_orders() to list the affected orders.
--
-- Nothing here is new arithmetic in a new place: every figure is built from
-- analytics_core, the same implementations the headline figures come from.
-- A share of a negative total is meaningless, so it is NULL rather than a
-- percentage nobody can read.
--
-- Depends on 0025. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Each channel, against the period before
-- ----------------------------------------------------------------------------

create function public.analytics_channel_compare(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  channel_id            uuid,
  channel_name          text,
  channel_type          public.channel_type,
  revenue               text,
  revenue_share         text,
  orders_count          bigint,
  units_sold            text,
  avg_order_value       text,
  cogs                  text,
  fees                  text,
  gross_profit          text,
  gross_margin          text,
  profit_share          text,
  cost_coverage         text,
  fee_coverage          text,
  previous_revenue      text,
  previous_orders       bigint,
  previous_gross_margin text,
  revenue_change        text,
  revenue_change_pct    text,
  orders_change_pct     text,
  profit_change         text,
  margin_change_pts     text,
  direction             text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur as (
  select * from analytics_core.analytics_channels(p_business_id, p_from, p_to)),
prev as (
  select * from analytics_core.analytics_channels(p_business_id, p_prev_from, p_prev_to)),
totals as (
  select coalesce(sum(revenue), 0) as revenue, coalesce(sum(gross_profit), 0) as gross_profit
  from cur
),
joined as (
  select
    coalesce(c.channel_id, p.channel_id)                as channel_id,
    coalesce(c.channel_name, p.channel_name)            as channel_name,
    coalesce(c.channel_type, p.channel_type)            as channel_type,
    c.revenue, c.cogs, c.fees, c.gross_profit, c.gross_margin,
    c.orders_count, c.units_sold, c.avg_order_value, c.cost_coverage, c.fee_coverage,
    p.revenue      as prev_revenue,
    p.orders_count as prev_orders,
    p.gross_margin as prev_margin,
    p.gross_profit as prev_profit
  from cur c
  -- Matched on the channel id, with a stand-in for "no channel" so that
  -- bucket matches itself across the two periods. PostgreSQL cannot FULL JOIN
  -- on `is not distinct from`: it has no way to hash or merge that.
  full outer join prev p
    on coalesce(p.channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
     = coalesce(c.channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
)
select
  j.channel_id,
  j.channel_name,
  j.channel_type,
  coalesce(j.revenue, 0)::text,
  (case when t.revenue > 0
        then round((coalesce(j.revenue, 0) / t.revenue) * 100, 2) end)::text  as revenue_share,
  coalesce(j.orders_count, 0),
  coalesce(j.units_sold, 0)::text,
  j.avg_order_value::text,
  coalesce(j.cogs, 0)::text,
  coalesce(j.fees, 0)::text,
  coalesce(j.gross_profit, 0)::text,
  j.gross_margin::text,
  -- Share of the profit the business actually made. When it made none, a
  -- percentage would be meaningless, so this is NULL.
  (case when t.gross_profit > 0
        then round((coalesce(j.gross_profit, 0) / t.gross_profit) * 100, 2) end)::text
                                                                              as profit_share,
  j.cost_coverage::text,
  j.fee_coverage::text,
  coalesce(j.prev_revenue, 0)::text,
  coalesce(j.prev_orders, 0),
  j.prev_margin::text,
  (coalesce(j.revenue, 0) - coalesce(j.prev_revenue, 0))::text                as revenue_change,
  (case when coalesce(j.prev_revenue, 0) > 0
        then round(((coalesce(j.revenue, 0) - j.prev_revenue) / j.prev_revenue) * 100, 2) end)::text
                                                                              as revenue_change_pct,
  (case when coalesce(j.prev_orders, 0) > 0
        then round(((coalesce(j.orders_count, 0) - j.prev_orders)::numeric / j.prev_orders) * 100, 2) end)::text
                                                                              as orders_change_pct,
  (coalesce(j.gross_profit, 0) - coalesce(j.prev_profit, 0))::text            as profit_change,
  -- Margin moves in POINTS, never in percent: 40% to 30% is ten points down,
  -- and calling that "-25%" is how a margin change gets misread.
  (case when j.gross_margin is not null and j.prev_margin is not null
        then round(j.gross_margin - j.prev_margin, 2) end)::text              as margin_change_pts,
  case when j.revenue is null      then 'gone'
       when j.prev_revenue is null then 'new'
       when j.revenue > j.prev_revenue then 'up'
       when j.revenue < j.prev_revenue then 'down'
       else 'flat' end                                                        as direction
from joined j, totals t
order by coalesce(j.revenue, 0) desc;
$$;


-- ----------------------------------------------------------------------------
-- 2. What changed, and what moved it
-- ----------------------------------------------------------------------------
-- Channels and products, for revenue and gross profit, ranked by how much they
-- moved. `share_of_change` is the driver's share of the total movement of its
-- own kind, so "Amazon accounts for 78% of the revenue increase" is a fact
-- about channels rather than a comparison against a different denominator.

create function public.analytics_change_drivers(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz,
  p_limit       integer default 5,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  driver_kind     text,
  driver_key      text,
  driver_label    text,
  metric          text,
  current_value   text,
  previous_value  text,
  change_amount   text,
  share_of_change text,
  direction       text,
  /** True when some of this driver's lines have no recorded value. */
  incomplete      boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur_ch as (
  select * from analytics_core.analytics_channels(
    p_business_id, p_from, p_to, p_channel_id, p_no_channel)),
prev_ch as (
  select * from analytics_core.analytics_channels(
    p_business_id, p_prev_from, p_prev_to, p_channel_id, p_no_channel)),
cur_pr as (
  select * from analytics_core.analytics_products(
    p_business_id, p_from, p_to, 500, p_channel_id, p_no_channel)),
prev_pr as (
  select * from analytics_core.analytics_products(
    p_business_id, p_prev_from, p_prev_to, 500, p_channel_id, p_no_channel)),
channels as (
  select
    'CHANNEL'::text                                                 as driver_kind,
    coalesce(c.channel_id::text, p.channel_id::text, 'unattributed') as driver_key,
    coalesce(c.channel_name, p.channel_name)                        as driver_label,
    coalesce(c.revenue, 0)                                          as cur_revenue,
    coalesce(p.revenue, 0)                                          as prev_revenue,
    coalesce(c.gross_profit, 0)                                     as cur_profit,
    coalesce(p.gross_profit, 0)                                     as prev_profit,
    false                                                           as incomplete
  from cur_ch c
  full outer join prev_ch p
    on coalesce(p.channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
     = coalesce(c.channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
),
products as (
  select
    'PRODUCT'::text                                                 as driver_kind,
    coalesce(c.product_key, p.product_key)                          as driver_key,
    coalesce(c.product_name, p.product_name)                        as driver_label,
    coalesce(c.revenue, 0)                                          as cur_revenue,
    coalesce(p.revenue, 0)                                          as prev_revenue,
    coalesce(c.gross_profit, 0)                                     as cur_profit,
    coalesce(p.gross_profit, 0)                                     as prev_profit,
    (coalesce(c.items_value_unknown, 0) + coalesce(p.items_value_unknown, 0)) > 0
                                                                    as incomplete
  from cur_pr c
  full outer join prev_pr p on p.product_key = c.product_key
  -- A product whose value is unknown in BOTH periods cannot have driven
  -- anything. It is reported under data quality instead.
  where c.revenue is not null or p.revenue is not null
),
all_drivers as (
  select * from channels
  union all
  select * from products
),
metrics as (
  select driver_kind, driver_key, driver_label, 'revenue'::text as metric,
         cur_revenue as cur_value, prev_revenue as prev_value, incomplete
  from all_drivers
  union all
  select driver_kind, driver_key, driver_label, 'gross_profit',
         cur_profit, prev_profit, incomplete
  from all_drivers
),
ranked as (
  select
    m.*,
    (m.cur_value - m.prev_value)                                            as change_amount,
    sum(m.cur_value - m.prev_value) over (partition by m.driver_kind, m.metric)
                                                                            as total_change,
    row_number() over (
      partition by m.driver_kind, m.metric
      order by abs(m.cur_value - m.prev_value) desc, m.driver_key)          as position
  from metrics m
)
select
  r.driver_kind,
  r.driver_key,
  r.driver_label,
  r.metric,
  r.cur_value::text,
  r.prev_value::text,
  r.change_amount::text,
  (case when r.total_change <> 0
        then round((r.change_amount / r.total_change) * 100, 2) end)::text   as share_of_change,
  case when r.change_amount > 0 then 'up'
       when r.change_amount < 0 then 'down'
       else 'flat' end                                                      as direction,
  r.incomplete
from ranked r
where r.position <= greatest(p_limit, 1)
  and r.change_amount <> 0
order by r.driver_kind, r.metric, abs(r.change_amount) desc;
$$;


-- ----------------------------------------------------------------------------
-- 3. Data quality, counted
-- ----------------------------------------------------------------------------
-- Every dimension is a pair: how many are recorded, how many are not, and the
-- share. A coverage with nothing to measure is NULL, never 100%.

create function public.analytics_data_quality(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  orders_count            bigint,
  items_total             bigint,
  items_with_cost         bigint,
  items_without_cost      bigint,
  cost_coverage           text,
  orders_with_fee         bigint,
  orders_without_fee      bigint,
  fee_coverage            text,
  orders_with_channel     bigint,
  orders_without_channel  bigint,
  channel_coverage        text,
  orders_with_customer    bigint,
  orders_without_customer bigint,
  customer_coverage       text,
  items_identified        bigint,
  items_without_identity  bigint,
  identity_coverage       text,
  items_value_known       bigint,
  items_value_derived     bigint,
  items_value_unknown     bigint,
  value_coverage          text,
  products_missing_cost   bigint,
  first_order_at          timestamptz,
  last_order_at           timestamptz,
  days_in_period          integer,
  days_with_orders        bigint,
  days_since_last_order   integer
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
    (oi.unit_cost is not null)                                   as has_cost,
    (nullif(trim(oi.sku), '') is not null
      or oi.product_id is not null
      or nullif(trim(oi.name), '') is not null)                  as identified,
    (oi.line_total is not null)                                  as value_given,
    (oi.line_total is null and oi.unit_price is not null)        as value_derived,
    (oi.line_total is null and oi.unit_price is null)            as value_unknown
  from public.order_items oi
  join counted c on c.id = oi.order_id
),
product_gaps as (
  select count(*) as missing_cost
  from analytics_core.analytics_products(
    p_business_id, p_from, p_to, 500, p_channel_id, p_no_channel) p
  where p.items_measured > 0 and p.items_with_cost < p.items_measured
),
base as (
  select
    (select count(*) from counted)                                           as orders_count,
    (select count(*) from lines)                                             as items_total,
    (select count(*) filter (where has_cost) from lines)                     as items_with_cost,
    (select count(*) filter (where not has_cost) from lines)                 as items_without_cost,
    (select count(*) filter (where fee_total is not null) from counted)      as orders_with_fee,
    (select count(*) filter (where fee_total is null) from counted)          as orders_without_fee,
    (select count(*) filter (where channel_id is not null) from counted)     as orders_with_channel,
    (select count(*) filter (where channel_id is null) from counted)         as orders_without_channel,
    (select count(*) filter (where customer_id is not null) from counted)    as orders_with_customer,
    (select count(*) filter (where customer_id is null) from counted)        as orders_without_customer,
    (select count(*) filter (where identified) from lines)                   as items_identified,
    (select count(*) filter (where not identified) from lines)               as items_without_identity,
    (select count(*) filter (where value_given or value_derived) from lines) as items_value_known,
    (select count(*) filter (where value_derived) from lines)                as items_value_derived,
    (select count(*) filter (where value_unknown) from lines)                as items_value_unknown,
    (select missing_cost from product_gaps)                                  as products_missing_cost,
    (select min(placed_at) from counted)                                     as first_order_at,
    (select max(placed_at) from counted)                                     as last_order_at,
    (select count(distinct date_trunc('day', placed_at)) from counted)       as days_with_orders
)
select
  b.orders_count,
  b.items_total,
  b.items_with_cost,
  b.items_without_cost,
  (case when b.items_total > 0
        then round((b.items_with_cost::numeric / b.items_total) * 100, 2) end)::text,
  b.orders_with_fee,
  b.orders_without_fee,
  (case when b.orders_count > 0
        then round((b.orders_with_fee::numeric / b.orders_count) * 100, 2) end)::text,
  b.orders_with_channel,
  b.orders_without_channel,
  (case when b.orders_count > 0
        then round((b.orders_with_channel::numeric / b.orders_count) * 100, 2) end)::text,
  b.orders_with_customer,
  b.orders_without_customer,
  (case when b.orders_count > 0
        then round((b.orders_with_customer::numeric / b.orders_count) * 100, 2) end)::text,
  b.items_identified,
  b.items_without_identity,
  (case when b.items_total > 0
        then round((b.items_identified::numeric / b.items_total) * 100, 2) end)::text,
  b.items_value_known,
  b.items_value_derived,
  b.items_value_unknown,
  (case when b.items_total > 0
        then round((b.items_value_known::numeric / b.items_total) * 100, 2) end)::text,
  b.products_missing_cost,
  b.first_order_at,
  b.last_order_at,
  greatest(ceil(extract(epoch from (p_to - p_from)) / 86400)::integer, 0)    as days_in_period,
  b.days_with_orders,
  case when b.last_order_at is not null
       then floor(extract(epoch from (now() - b.last_order_at)) / 86400)::integer end
                                                                             as days_since_last_order
from base b;
$$;


-- ----------------------------------------------------------------------------
-- 4. The orders behind one data-quality gap
-- ----------------------------------------------------------------------------
-- So "10 of 233 orders have no recorded fee" can be opened and acted on.
-- Paged in the database: a business with 80,000 orders must not ship them all
-- to a browser so JavaScript can hide most of them.

create function public.analytics_quality_orders(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_issue       text,
  p_limit       integer default 50,
  p_offset      integer default 0,
  p_channel_id  uuid    default null,
  p_no_channel  boolean default false
)
returns table (
  order_id            uuid,
  order_number        text,
  placed_at           timestamptz,
  channel_name        text,
  total               text,
  fee_total           text,
  items_total         bigint,
  items_without_cost  bigint,
  items_value_unknown bigint,
  /** How many orders match this gap in total, so the list can be paged. */
  matched_count       bigint
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
per_order as (
  select
    c.id,
    c.channel_id,
    c.customer_id,
    c.total,
    c.fee_total,
    c.placed_at,
    count(oi.id)                                                        as items_total,
    count(oi.id) filter (where oi.unit_cost is null)                    as items_without_cost,
    count(oi.id) filter (where oi.line_total is null and oi.unit_price is null)
                                                                        as items_value_unknown
  from counted c
  left join public.order_items oi on oi.order_id = c.id
  group by c.id, c.channel_id, c.customer_id, c.total, c.fee_total, c.placed_at
),
matched as (
  select p.*
  from per_order p
  where case upper(p_issue)
          when 'NO_FEE'        then p.fee_total is null
          when 'NO_CHANNEL'    then p.channel_id is null
          when 'NO_CUSTOMER'   then p.customer_id is null
          when 'MISSING_COST'  then p.items_without_cost > 0
          when 'UNKNOWN_VALUE' then p.items_value_unknown > 0
          when 'NO_LINES'      then p.items_total = 0
          else true
        end
)
select
  m.id                                          as order_id,
  o.order_number,
  m.placed_at,
  ch.name                                       as channel_name,
  m.total::text,
  m.fee_total::text,
  m.items_total,
  m.items_without_cost,
  m.items_value_unknown,
  (select count(*) from matched)                as matched_count
from matched m
join public.orders o on o.id = m.id
left join public.channels ch on ch.id = m.channel_id
order by m.placed_at desc
limit greatest(p_limit, 1)
offset greatest(p_offset, 0);
$$;


-- ----------------------------------------------------------------------------
-- 5. Privileges
-- ----------------------------------------------------------------------------

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.analytics_channel_compare(uuid, timestamptz, timestamptz, timestamptz, timestamptz)',
    'public.analytics_change_drivers(uuid, timestamptz, timestamptz, timestamptz, timestamptz, integer, uuid, boolean)',
    'public.analytics_data_quality(uuid, timestamptz, timestamptz, uuid, boolean)',
    'public.analytics_quality_orders(uuid, timestamptz, timestamptz, text, integer, integer, uuid, boolean)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', v_sig);
    execute format('grant execute on function %s to authenticated', v_sig);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_fn       text;
  v_type     text;
  v_business uuid;
  v_total    numeric;
  v_shares   numeric;
begin
  foreach v_fn in array array[
    'analytics_channel_compare', 'analytics_change_drivers',
    'analytics_data_quality', 'analytics_quality_orders'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: authenticated cannot execute public.%().', v_fn;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute public.%().', v_fn;
    end if;

    select pg_get_function_result(p.oid) into v_type
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if position('numeric' in v_type) > 0 then
      raise exception
        'public.%() returns a numeric column, so money would reach JavaScript as a double.', v_fn;
    end if;
  end loop;

  -- Channel shares must add up to the whole, for every business that made any
  -- revenue at all in the last decade.
  for v_business in select id from public.businesses order by created_at limit 25 loop
    select coalesce(sum(revenue::numeric), 0), coalesce(sum(nullif(revenue_share, '')::numeric), 0)
    into v_total, v_shares
    from public.analytics_channel_compare(
      v_business,
      now() - interval '3650 days', now() + interval '1 day',
      now() - interval '7300 days', now() - interval '3650 days');

    if v_total > 0 and abs(v_shares - 100) > 0.5 then
      raise exception 'Channel revenue shares add to % for business %, not 100.', v_shares, v_business;
    end if;
  end loop;

  raise notice
    'Migration 0026 verified: channel comparison, change drivers, data quality '
    'and the gap listing are installed, service-role safe, text-only, and '
    'channel shares add up.';
end;
$$;


commit;
