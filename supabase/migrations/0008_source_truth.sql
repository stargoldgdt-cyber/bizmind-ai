-- ============================================================================
-- BizMind AI -- Migration 0008: Source truth and unverified semantics
-- ============================================================================
--
-- Two corrections, both about the same principle: BizMind must preserve what a
-- source actually said without pretending to understand what it meant.
--
-- 1. BLANK IS NOT ZERO
--    Optional money columns were NOT NULL DEFAULT 0, so a blank cell in an
--    import became a recorded zero. Those are different facts. "Advertising
--    cost was 0" is a business statement; "advertising cost was not in the
--    file" is a gap in our knowledge, and only one of them should reduce a
--    profit figure with confidence.
--
--    They are now nullable. NULL means not recorded; 0 means recorded as zero.
--    Analytics treats NULL as zero WHEN SUMMING -- there is nothing else it
--    could do -- but counts the unknowns separately and reports them, exactly
--    as it already does for missing costs.
--
-- 2. A SOURCE FIELD IS NOT A BIZMIND METRIC UNTIL SOMEONE SAYS SO
--    A column called "product Wholesale Price" is not cost of goods because
--    the words look similar. It might be the cost of the units sold in the
--    period, or procurement spend for the period, or something specific to how
--    that seller keeps their books. Those produce very different profit
--    figures, and choosing between them by reading the column name would be
--    guessing about money.
--
--    source_records preserves every source row verbatim. source_field_semantics
--    records what each field is believed to mean, who confirmed it, and
--    whether it may be used as a BizMind metric. Nothing is promoted from
--    source to verified without an explicit, attributable decision.
--
-- WHY THIS BELONGS IN THE UNIVERSAL DATA MODEL
-- --------------------------------------------
-- Every future connector will bring fields we did not anticipate. Without a
-- place to hold them honestly, the choice is to discard them or to guess at
-- them. This is the third option: keep them, show them, and mark them
-- unverified until a human says otherwise.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Blank is not zero
-- ----------------------------------------------------------------------------
-- `total` and `quantity` stay NOT NULL: they are required by the importer, and
-- an order with no total is not an order.

alter table public.orders
  alter column subtotal       drop not null,
  alter column subtotal       drop default,
  alter column discount_total drop not null,
  alter column discount_total drop default,
  alter column tax_total      drop not null,
  alter column tax_total      drop default,
  alter column shipping_total drop not null,
  alter column shipping_total drop default,
  alter column fee_total      drop not null,
  alter column fee_total      drop default;

comment on column public.orders.fee_total is
  'Marketplace commission, payment processing and fulfilment. NULL means the '
  'source did not record it -- which is NOT the same as a fee of zero. Profit '
  'that ignores unrecorded fees is overstated, so the count of orders with '
  'unknown fees is reported alongside every margin.';

comment on column public.orders.subtotal is
  'NULL means not recorded by the source. Zero means recorded as zero.';

alter table public.order_items
  alter column unit_price drop not null,
  alter column unit_price drop default,
  alter column discount   drop not null,
  alter column discount   drop default,
  alter column tax        drop not null,
  alter column tax        drop default,
  alter column line_total drop not null,
  alter column line_total drop default;

comment on column public.order_items.unit_price is
  'NULL means not recorded by the source. Zero means sold at no charge.';

-- Finding orders whose fees were never recorded, for the honesty warnings.
create index orders_fees_unknown_idx
  on public.orders (business_id)
  where fee_total is null;


-- ----------------------------------------------------------------------------
-- 2. source_records -- what the source actually said
-- ----------------------------------------------------------------------------
-- One row per source record, preserved verbatim. This is not a staging table
-- that gets cleared: it is the evidence behind every figure, kept so that
-- months later it is still possible to answer "where did this number come
-- from, and what else did that file say?"

create table public.source_records (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  import_batch_id uuid references public.import_batches (id) on delete set null,

  source          public.channel_type not null,
  /** What kind of record this is, in the SOURCE's terms. Free text on purpose:
      "settlement_period", "order", "payout". Constraining it would mean
      deciding in advance what shapes the world is allowed to send us. */
  record_type     text not null,
  external_id     text,

  /* Period-based reports (settlements, payouts) rather than single events. */
  period_start    timestamptz,
  period_end      timestamptz,

  /**
   * The record exactly as supplied. A blank cell is JSON null, NEVER 0.
   * Numbers are stored as strings to preserve the source's own precision.
   */
  figures         jsonb not null default '{}'::jsonb,

  /**
   * Fields that were blank in the source. Recorded explicitly so that blank
   * stays distinguishable from zero permanently, even if `figures` is later
   * re-serialised by some other tool.
   */
  blank_fields    text[] not null default '{}',

  /**
   * Reconciliation checks run against this record at import time, e.g.
   * [{"name":"sales_minus_expense_equals_payment","expected":"49648.59",
   *   "actual":"49648.59","passed":true}]
   *
   * A failed check is RECORDED, never corrected. Silently fixing a source
   * would destroy the only evidence that it disagreed with itself.
   */
  checks          jsonb not null default '[]'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.source_records is
  'Source rows preserved verbatim, including fields BizMind does not map. The '
  'evidence behind every derived figure.';

create index source_records_business_idx
  on public.source_records (business_id, period_start desc);
create index source_records_batch_idx
  on public.source_records (import_batch_id);

create unique index source_records_external_key
  on public.source_records (business_id, source, record_type, external_id)
  where external_id is not null;

create trigger source_records_set_updated_at
  before update on public.source_records
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 3. source_field_semantics -- what we believe a field means, and who said so
-- ----------------------------------------------------------------------------
-- The gate between "the source has a column" and "BizMind has a metric".

create type public.semantics_status as enum (
  'UNVERIFIED',  -- meaning not established. May be displayed, never used.
  'CONFIRMED',   -- meaning established by a person. May map to a metric.
  'REJECTED'     -- examined and found NOT to mean what it appeared to
);

create table public.source_field_semantics (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  source        public.channel_type not null,

  /** Our normalised key, e.g. product_wholesale_price. */
  field_key     text not null,
  /** The source's own column name, verbatim, including its odd casing. */
  source_label  text not null,

  status        public.semantics_status not null default 'UNVERIFIED',

  /**
   * The BizMind metric this field is permitted to feed. NULL while
   * unverified. A non-null value here is the ONLY thing that allows a source
   * figure to become a BizMind figure.
   */
  maps_to       text,

  /** What is known, and what remains unknown. Shown to the user verbatim. */
  note          text,

  /** What evidence would settle the question. */
  resolution_hint text,

  confirmed_by  uuid references public.profiles (id) on delete set null,
  confirmed_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (business_id, source, field_key),

  /* A field cannot map to a metric unless it has been confirmed, and a
     confirmation must record who made it. The rule is enforced here rather
     than in application code so it cannot be bypassed. */
  constraint semantics_mapping_requires_confirmation
    check (maps_to is null or status = 'CONFIRMED'),
  constraint semantics_confirmation_requires_attribution
    check (status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null))
);

comment on table public.source_field_semantics is
  'The gate between a source column and a BizMind metric. A field may only '
  'feed a verified figure once a person has confirmed what it means.';

create trigger source_field_semantics_set_updated_at
  before update on public.source_field_semantics
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. Confirming semantics -- attributable, audited, never automatic
-- ----------------------------------------------------------------------------

create or replace function public.confirm_source_field_semantics(
  p_business_id uuid,
  p_source      public.channel_type,
  p_field_key   text,
  p_status      public.semantics_status,
  p_maps_to     text default null,
  p_note        text default null
)
returns public.source_field_semantics
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_row  public.source_field_semantics;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- Only an owner or admin may decide that a source field means something. It
  -- changes what every profit figure in the business is built from.
  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can confirm what a source field means.'
      using errcode = '42501';
  end if;

  if p_status = 'CONFIRMED' and p_maps_to is null then
    raise exception
      'Confirming a field requires stating which BizMind metric it maps to, or '
      'recording it as CONFIRMED-but-unmapped by passing an explicit metric key.'
      using errcode = 'P0001';
  end if;

  insert into public.source_field_semantics (
    business_id, source, field_key, source_label, status, maps_to, note,
    confirmed_by, confirmed_at
  )
  values (
    p_business_id, p_source, p_field_key, p_field_key, p_status, p_maps_to, p_note,
    case when p_status = 'CONFIRMED' then v_user end,
    case when p_status = 'CONFIRMED' then now() end
  )
  on conflict (business_id, source, field_key) do update set
    status       = excluded.status,
    maps_to      = excluded.maps_to,
    note         = coalesce(excluded.note, public.source_field_semantics.note),
    confirmed_by = excluded.confirmed_by,
    confirmed_at = excluded.confirmed_at
  returning * into v_row;

  perform public.write_audit_log(
    p_business_id,
    'source_field_semantics.' || lower(p_status::text),
    'source_field_semantics',
    v_row.id,
    null,
    jsonb_build_object(
      'field_key', p_field_key,
      'status', p_status,
      'maps_to', p_maps_to,
      'note', p_note
    )
  );

  return v_row;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Analytics: unknown fees are counted, not assumed
-- ----------------------------------------------------------------------------
-- Summing treats NULL as zero because there is nothing else it can do. What
-- changes is that the engine now says how many orders that applied to, so a
-- margin built on unrecorded fees announces itself the way an incomplete cost
-- figure already does.
--
-- These two functions gain columns, and PostgreSQL cannot change a function's
-- return type in place -- CREATE OR REPLACE fails with 42P13. They are dropped
-- and recreated instead.
--
-- Dropping also DISCARDS their privileges, so the grants are reissued in
-- section 5c. Missing that would leave the analytics engine installed but
-- unusable by every signed-in user.
--
-- Safe to drop despite analytics_reconciliation() and analytics_health_inputs()
-- calling them: a SQL function body given as a string literal is not parsed for
-- dependencies, so callers resolve to the new definition at run time.

drop function if exists public.analytics_financials(uuid, timestamptz, timestamptz);
drop function if exists public.analytics_channels(uuid, timestamptz, timestamptz);

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
  line_revenue           numeric,
  orders_fees_unknown    bigint,
  fee_coverage           numeric
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
    coalesce((select sum(coalesce(fee_total, 0)) from counted), 0)      as fees,
    coalesce((select count(*) from counted), 0)                         as orders_count,
    coalesce((select count(distinct customer_id) from counted
               where customer_id is not null), 0)                       as customers_count,
    coalesce((select count(*) from counted where fee_total = 0), 0)     as orders_zero_fees,
    coalesce((select count(*) from counted where fee_total is null), 0) as orders_fees_unknown,
    coalesce((select count(*) from counted where channel_id is null), 0) as orders_without_channel,
    coalesce((select sum(quantity) from lines), 0)                      as units_sold,
    coalesce((select sum(line_cost) from lines), 0)                     as cogs,
    coalesce((select sum(coalesce(line_total, 0)) from lines), 0)       as line_revenue,
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
  b.line_revenue,
  b.orders_fees_unknown,
  -- The share of orders whose fees are actually known. Below 100 means profit
  -- is overstated by an unknown amount, for the same reason a missing cost does.
  case when b.orders_count > 0
       then round(((b.orders_count - b.orders_fees_unknown)::numeric
                   / b.orders_count) * 100, 2) end             as fee_coverage
from base b;
$$;


-- Channels: same treatment, so a channel with unrecorded fees says so.
create or replace function public.analytics_channels(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
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
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
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


-- Products: line totals and fee shares must tolerate unrecorded values.
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
  select oi.order_id, sum(coalesce(oi.line_total, 0)) as order_line_total
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
    coalesce(oi.line_total, 0)                       as line_total,
    coalesce(oi.quantity * oi.unit_cost, 0)          as line_cost,
    (oi.unit_cost is not null)                       as has_cost,
    case when olt.order_line_total > 0
         then coalesce(c.fee_total, 0)
              * (coalesce(oi.line_total, 0) / olt.order_line_total)
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
-- 5c. Reissue privileges lost to the drops above
-- ----------------------------------------------------------------------------

revoke all on function public.analytics_financials(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_financials(uuid, timestamptz, timestamptz)
  to authenticated;

revoke all on function public.analytics_channels(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_channels(uuid, timestamptz, timestamptz)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 6. Import: stop coercing blanks to zero
-- ----------------------------------------------------------------------------

create or replace function public.import_apply_orders(
  p_batch_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch          public.import_batches;
  v_row            jsonb;
  v_item           jsonb;
  v_customer_id    uuid;
  v_order_id       uuid;
  v_inserted       boolean;
  v_created        integer := 0;
  v_updated        integer := 0;
  v_items          integer := 0;
  v_customers      integer := 0;
  v_missing_cost   integer := 0;
  v_missing_fees   integer := 0;
  v_email          text;
begin
  v_batch := public.import_load_batch(p_batch_id);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_customer_id := null;
    v_email := nullif(trim(v_row ->> 'customer_email'), '');

    if v_email is not null then
      insert into public.customers (business_id, email, full_name, source)
      values (
        v_batch.business_id,
        v_email,
        nullif(trim(v_row ->> 'customer_name'), ''),
        v_batch.source
      )
      on conflict (business_id, lower(email)) where email is not null
      do update set
        full_name = coalesce(public.customers.full_name, excluded.full_name)
      returning id, (xmax = 0) into v_customer_id, v_inserted;

      if v_inserted then
        v_customers := v_customers + 1;
      end if;
    end if;

    -- Money fields are written AS SUPPLIED. A field absent from the file stays
    -- NULL, so "not recorded" survives into the database instead of becoming a
    -- confident zero that quietly inflates profit.
    insert into public.orders (
      business_id, channel_id, customer_id, source, external_id, order_number,
      status, currency, subtotal, discount_total, tax_total, shipping_total,
      fee_total, total, placed_at
    )
    values (
      v_batch.business_id,
      v_batch.channel_id,
      v_customer_id,
      v_batch.source,
      v_row ->> 'external_id',
      nullif(trim(v_row ->> 'order_number'), ''),
      coalesce((v_row ->> 'status')::public.order_status, 'FULFILLED'),
      v_row ->> 'currency',
      (v_row ->> 'subtotal')::numeric,
      (v_row ->> 'discount_total')::numeric,
      (v_row ->> 'tax_total')::numeric,
      (v_row ->> 'shipping_total')::numeric,
      (v_row ->> 'fee_total')::numeric,
      coalesce((v_row ->> 'total')::numeric, 0),
      (v_row ->> 'placed_at')::timestamptz
    )
    on conflict (business_id, source, external_id) where external_id is not null
    do update set
      channel_id     = excluded.channel_id,
      customer_id    = coalesce(excluded.customer_id, public.orders.customer_id),
      order_number   = coalesce(excluded.order_number, public.orders.order_number),
      status         = excluded.status,
      currency       = excluded.currency,
      subtotal       = excluded.subtotal,
      discount_total = excluded.discount_total,
      tax_total      = excluded.tax_total,
      shipping_total = excluded.shipping_total,
      fee_total      = excluded.fee_total,
      total          = excluded.total,
      placed_at      = excluded.placed_at
    returning id, (xmax = 0) into v_order_id, v_inserted;

    if v_inserted then
      v_created := v_created + 1;
    else
      v_updated := v_updated + 1;
    end if;

    if (v_row ->> 'fee_total') is null then
      v_missing_fees := v_missing_fees + 1;
    end if;

    delete from public.order_items where order_id = v_order_id;

    for v_item in select * from jsonb_array_elements(coalesce(v_row -> 'items', '[]'::jsonb))
    loop
      insert into public.order_items (
        business_id, order_id, sku, name, quantity, unit_price, unit_cost,
        discount, tax, line_total
      )
      values (
        v_batch.business_id,
        v_order_id,
        nullif(trim(v_item ->> 'sku'), ''),
        nullif(trim(v_item ->> 'name'), ''),
        (v_item ->> 'quantity')::numeric,
        (v_item ->> 'unit_price')::numeric,
        (v_item ->> 'unit_cost')::numeric,
        (v_item ->> 'discount')::numeric,
        (v_item ->> 'tax')::numeric,
        (v_item ->> 'line_total')::numeric
      );

      v_items := v_items + 1;
      if (v_item ->> 'unit_cost') is null then
        v_missing_cost := v_missing_cost + 1;
      end if;
    end loop;
  end loop;

  -- Identity only. Never a cost. See migration 0005.
  update public.order_items oi
  set variant_id = pv.id,
      product_id = pv.product_id
  from public.product_variants pv
  where pv.business_id = v_batch.business_id
    and oi.business_id = v_batch.business_id
    and oi.variant_id is null
    and oi.sku is not null
    and pv.sku = oi.sku;

  update public.import_batches
  set status        = 'COMPLETED',
      created_count = v_created,
      updated_count = v_updated,
      committed_at  = now()
  where id = p_batch_id;

  return jsonb_build_object(
    'orders_created',      v_created,
    'orders_updated',      v_updated,
    'items_written',       v_items,
    'customers_created',   v_customers,
    'items_missing_cost',  v_missing_cost,
    'orders_missing_fees', v_missing_fees
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Row Level Security
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['source_records', 'source_field_semantics']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_insert_staff', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_update_staff', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_delete_admin', t);

    execute format('revoke all on public.%I from anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

revoke all on function public.confirm_source_field_semantics(
  uuid, public.channel_type, text, public.semantics_status, text, text)
  from anon, public;
grant execute on function public.confirm_source_field_semantics(
  uuid, public.channel_type, text, public.semantics_status, text, text)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 8. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t          text;
  v_rls      boolean;
  v_policies integer;
  v_column   text;
  v_function text;
  v_business uuid;
  v_gate_held boolean := false;
begin
  foreach t in array array['source_records', 'source_field_semantics']
  loop
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = t;

    if v_policies <> 4 then
      raise exception 'SECURITY: table public.% has % policies, expected 4', t, v_policies;
    end if;
  end loop;

  -- Blank must be able to survive as NULL rather than becoming a recorded zero.
  foreach v_column in array array[
    'subtotal', 'discount_total', 'tax_total', 'shipping_total', 'fee_total'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'orders'
        and column_name = v_column and is_nullable = 'NO'
    ) then
      raise exception
        'orders.% is still NOT NULL, so a blank source value would become zero',
        v_column;
    end if;
  end loop;

  -- The gate must hold: an UNVERIFIED field cannot map to a BizMind metric.
  --
  -- Needs a real business to satisfy the foreign key. On a database with none
  -- yet the check is SKIPPED and said so, rather than being reported as a pass
  -- it never performed.
  select id into v_business from public.businesses limit 1;

  if v_business is null then
    raise notice
      'No businesses exist yet, so the semantics gate could not be exercised. '
      'The CHECK constraint is still in place; re-run this assertion once a '
      'business exists.';
  else
    begin
      insert into public.source_field_semantics
        (business_id, source, field_key, source_label, status, maps_to)
      values
        (v_business, 'AMAZON', 'gate_check', 'gate check', 'UNVERIFIED', 'cogs');
    exception
      when check_violation then
        v_gate_held := true;
    end;

    if not v_gate_held then
      -- The insert should have been impossible. Remove the row before failing,
      -- so a rejected migration leaves nothing behind.
      delete from public.source_field_semantics
      where business_id = v_business and field_key = 'gate_check';

      raise exception
        'SAFETY: an UNVERIFIED source field was allowed to map to a BizMind metric.';
    end if;
  end if;

  -- Dropping a function discards its privileges. Prove they were reissued:
  -- an analytics engine nobody may execute is a silent, total outage.
  foreach v_function in array array['analytics_financials', 'analytics_channels']
  loop
    if not exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_function
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception
        'SECURITY: authenticated cannot execute %(). The drop removed its grant.',
        v_function;
    end if;
  end loop;

  raise notice
    'Migration 0008 verified: blanks stay NULL, source truth preserved, semantics gate holds, analytics grants intact.';
end;
$$;


commit;
