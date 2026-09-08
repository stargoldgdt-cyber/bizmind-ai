-- ============================================================================
-- BizMind AI — Migration 0003: Dashboard metrics
-- ============================================================================
--
-- The first piece of the analytics engine: headline business figures and
-- per-channel performance, computed in SQL.
--
-- WHY THESE ARE SQL FUNCTIONS AND NOT APPLICATION CODE
-- ---------------------------------------------------
-- Financial arithmetic happens in the database, always. Two reasons:
--
--   1. `numeric` is exact decimal arithmetic. The moment a figure is parsed
--      into a JavaScript number it becomes binary floating point, where 0.10
--      cannot be represented and the error compounds across aggregation.
--
--   2. It is the same boundary that keeps the AI honest. The database computes
--      the number; the application displays it; the AI only ever explains a
--      figure it was handed. No layer above this one is allowed to invent or
--      recalculate a business metric.
--
-- SECURITY INVOKER (the default) is deliberate. These run as the calling user,
-- so Row Level Security applies to every table they read. A caller asking
-- about a business they do not belong to gets zeros — not an error, which
-- would confirm the business exists.
--
-- HONESTY ABOUT INCOMPLETE DATA
-- -----------------------------
-- `unit_cost` can be null when a cost was never recorded. Those lines
-- contribute nothing to COGS, which silently INFLATES gross profit — a wrong
-- number that looks entirely plausible.
--
-- Rather than hide that, the summary returns `items_total` and
-- `items_with_cost` so the interface can tell the owner exactly how much of
-- their margin is actually backed by cost data. A number the user cannot
-- trust must announce itself.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. dashboard_summary — the headline figures
-- ----------------------------------------------------------------------------
-- Cancelled orders are excluded throughout: they are not revenue, and counting
-- them would overstate every downstream figure.

create or replace function public.dashboard_summary(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  revenue          numeric,
  order_count      bigint,
  units_sold       numeric,
  cogs             numeric,
  fees             numeric,
  gross_profit     numeric,
  gross_margin     numeric,
  expenses         numeric,
  net_profit       numeric,
  net_margin       numeric,
  avg_order_value  numeric,
  customer_count   bigint,
  refunds          numeric,
  -- Cost-data coverage, so the interface can flag an unreliable margin.
  items_total      bigint,
  items_with_cost  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted_orders as (
  select o.id, o.total, o.fee_total, o.customer_id
  from public.orders o
  where o.business_id = p_business_id
    and o.placed_at >= p_from
    and o.placed_at <  p_to
    and o.status <> 'CANCELLED'
),
lines as (
  select
    oi.quantity,
    oi.unit_cost,
    -- A line with no recorded cost contributes 0 to COGS. It is counted
    -- separately below so the gap is visible rather than silent.
    coalesce(oi.quantity * oi.unit_cost, 0) as line_cost,
    (oi.unit_cost is not null)              as has_cost
  from public.order_items oi
  join counted_orders c on c.id = oi.order_id
),
totals as (
  select
    coalesce((select sum(total)      from counted_orders), 0) as revenue,
    coalesce((select count(*)        from counted_orders), 0) as order_count,
    coalesce((select sum(fee_total)  from counted_orders), 0) as fees,
    coalesce((select count(distinct customer_id)
                from counted_orders
               where customer_id is not null), 0)             as customer_count,
    coalesce((select sum(quantity)   from lines), 0)          as units_sold,
    coalesce((select sum(line_cost)  from lines), 0)          as cogs,
    coalesce((select count(*)        from lines), 0)          as items_total,
    coalesce((select count(*) filter (where has_cost)
                from lines), 0)                               as items_with_cost,
    coalesce((select sum(e.amount)
                from public.expenses e
               where e.business_id = p_business_id
                 and e.incurred_at >= p_from
                 and e.incurred_at <  p_to), 0)               as expenses,
    coalesce((select sum(r.refund_amount)
                from public.returns r
               where r.business_id = p_business_id
                 and r.occurred_at >= p_from
                 and r.occurred_at <  p_to
                 and r.status in ('REFUNDED', 'RECEIVED', 'APPROVED')), 0) as refunds
)
select
  t.revenue,
  t.order_count,
  t.units_sold,
  t.cogs,
  t.fees,
  (t.revenue - t.cogs - t.fees)                        as gross_profit,
  -- Guarded against divide-by-zero: no revenue means no margin, not an error.
  case when t.revenue > 0
       then round(((t.revenue - t.cogs - t.fees) / t.revenue) * 100, 2)
  end                                                  as gross_margin,
  t.expenses,
  (t.revenue - t.cogs - t.fees - t.expenses)           as net_profit,
  case when t.revenue > 0
       then round(((t.revenue - t.cogs - t.fees - t.expenses) / t.revenue) * 100, 2)
  end                                                  as net_margin,
  case when t.order_count > 0
       then round(t.revenue / t.order_count, 2)
  end                                                  as avg_order_value,
  t.customer_count,
  t.refunds,
  t.items_total,
  t.items_with_cost
from totals t;
$$;

comment on function public.dashboard_summary(uuid, timestamptz, timestamptz) is
  'Headline business figures for a period. Runs as the caller, so RLS applies '
  'and a non-member receives zeros rather than an error.';


-- ----------------------------------------------------------------------------
-- 2. channel_performance — the product's signature insight
-- ----------------------------------------------------------------------------
-- "The website earns less revenue than Amazon but a stronger margin" is the
-- kind of conclusion BizMind exists to make obvious. It is only possible
-- because fees are tracked per order rather than lumped into expenses.

create or replace function public.channel_performance(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  channel_id     uuid,
  channel_name   text,
  channel_type   public.channel_type,
  revenue        numeric,
  order_count    bigint,
  cogs           numeric,
  fees           numeric,
  gross_profit   numeric,
  gross_margin   numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted_orders as (
  select o.id, o.channel_id, o.total, o.fee_total
  from public.orders o
  where o.business_id = p_business_id
    and o.placed_at >= p_from
    and o.placed_at <  p_to
    and o.status <> 'CANCELLED'
),
line_costs as (
  select c.channel_id,
         sum(coalesce(oi.quantity * oi.unit_cost, 0)) as cogs
  from public.order_items oi
  join counted_orders c on c.id = oi.order_id
  group by c.channel_id
),
by_channel as (
  select
    c.channel_id,
    sum(c.total)     as revenue,
    count(*)         as order_count,
    sum(c.fee_total) as fees
  from counted_orders c
  group by c.channel_id
)
select
  b.channel_id,
  -- Orders with no channel still have to appear somewhere, or the totals on
  -- this view would not reconcile with the headline revenue figure.
  coalesce(ch.name, 'Unattributed')            as channel_name,
  coalesce(ch.type, 'OTHER'::public.channel_type) as channel_type,
  b.revenue,
  b.order_count,
  coalesce(lc.cogs, 0)                         as cogs,
  b.fees,
  (b.revenue - coalesce(lc.cogs, 0) - b.fees)  as gross_profit,
  case when b.revenue > 0
       then round(((b.revenue - coalesce(lc.cogs, 0) - b.fees) / b.revenue) * 100, 2)
  end                                          as gross_margin
from by_channel b
left join line_costs lc on lc.channel_id is not distinct from b.channel_id
left join public.channels ch on ch.id = b.channel_id
order by b.revenue desc;
$$;

comment on function public.channel_performance(uuid, timestamptz, timestamptz) is
  'Revenue, cost, fees and margin per sales channel. Orders with no channel '
  'are grouped as Unattributed so totals reconcile with dashboard_summary.';


-- ----------------------------------------------------------------------------
-- 3. Privileges
-- ----------------------------------------------------------------------------

revoke all on function public.dashboard_summary(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.dashboard_summary(uuid, timestamptz, timestamptz)
  to authenticated;

revoke all on function public.channel_performance(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.channel_performance(uuid, timestamptz, timestamptz)
  to authenticated;


commit;
