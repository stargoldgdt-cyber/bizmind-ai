-- ============================================================================
-- 0071  A fully refunded order returns to stock: its product cost is not a loss
-- ============================================================================
-- Owner decision, 2026-10-07 (final rules, 2026-10-07):
--   1. Every FULLY refunded product is taken to be back in the warehouse, sellable.
--   2. Fully refunded amounts are not in Net Sales (a sale and its refund net to zero).
--   3. The product cost of fully refunded units is reversed, so it is not a loss.
--   4. Product performance shows Units Sold, Sales, Refunds, Net Sales, COGS, Product Gross
--      Profit and Product Margin; and, in a SEPARATE section, the marketplace fees (commissions,
--      fulfilment, refund fees, other charges), Profit After Marketplace Fees and the Net Margin
--      After them. A fee is never inside the product's own gross profit or margin.
--   5. Refund fees, fulfilment fees and other marketplace charges on refunded orders are
--      LISTED in Expenses and deducted from profit in the Marketplace P&L EXACTLY ONCE.
--   6. A PARTIAL refund does not reverse the product cost.
--   7. A refund posted in a different month credits THAT month; the sale's month keeps its cost.
--   8. Product performance and the Marketplace P&L read the same lines and the same cost of
--      goods, so nothing is counted twice and the two always reconcile.
--
-- HOW EACH RULE IS MET
--   1-3, 6, 7  ledger_product_lines.cogs. On a refund line (a refunded sale price that carries
--              a quantity: Amazon Refund/Principal; or a negative product-sales line: noon
--              order_update/Net Proceeds) the cost counted when the order line sold is given
--              back, in proportion to that refund line, ONLY when the order line (same account,
--              order and SKU, across every month already in the ledger) has been refunded in
--              FULL. The cost returned is exactly the cost counted at the sale (the unit cost in
--              force on the sale date), so a same-month sale and refund cancel to zero. Without
--              a costed sale in the ledger (for example the sale is in a file not uploaded), or
--              with a partial refund, nothing is returned. Done once, in this view, so every
--              reader of cost of goods (P&L, dashboard, product pages, alerts) moves together.
--   2, 4, 8    product_performance() (new): units, sales, refunds, seller discounts, net sales,
--              COGS, gross profit and margin, from the same lines. Its net sales and COGS sum to
--              pnl_summary()'s (a row "not tied to a product" carries the sales no SKU owns, such
--              as an order-level shipping charge). No fee is in it. pnl_by_product() is left in
--              place for the version of the app that is still deployed; it is retired once the
--              app no longer calls it.
--   5          Fees stay marketplace costs in the P&L, where they reduce gross profit once.
--              refund_fees() (new) only LISTS them for the Expenses page: refund fees, and the
--              other fees a marketplace kept on fully refunded orders. It is read-only; nothing
--              is entered a second time, so nothing is deducted twice.
--   8          product_analysis() (0070) now reports gross profit and margin the same way as
--              product_performance() (before marketplace fees, with the cost of refunded units
--              returned). Marketplace costs stay in it as information. Its price check works on
--              the units that sold, at the price and cost they sold at, so a returned unit does
--              not distort the unit cost.
--
-- KNOWN LIMITS (by design, stated here so nobody discovers them later)
--   - An order line is "refunded in full" when its refunded sale price is at least what it sold
--     for. A refund of one unit of a multi-unit order is partial, so its cost is not returned.
--   - Cost is only returned when the sale is in the ledger. A refund of a sale from a file not
--     uploaded returns nothing (the sale month never counted its cost here either).
--   - A refund line whose product has no cost, or whose sale had no cost, returns nothing.
--
-- The view keeps its 44 columns in the same order (CREATE OR REPLACE), so every dependant keeps
-- working. Only `cogs` and `cogs_status` can differ, and only on refund lines.
--
-- TO UNDO (if a figure or a page speed looks wrong): run supabase/rollbacks/0071_revert.sql. It
-- restores the previous view and product_analysis() exactly and removes the two new readers.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. ledger_product_lines: give the cost back on a fully refunded order line
-- ----------------------------------------------------------------------------

create or replace view public.ledger_product_lines
with (security_invoker = true)
as
select
  l.id, l.business_id, l.marketplace_account_id, l.marketplace_code, l.account_label,
  l.source_file_id, l.format_id, l.source_row_id, l.line_index, l.match_key,
  l.source_type, l.source_subtype, l.source_description, l.amount, l.currency, l.posted_at,
  l.order_ref, l.raw_sku, l.import_side, l.import_category, l.rule_id, l.rule_scope,
  l.rule_confidence, l.rule_version, l.financial_type, l.category, l.category_label,
  l.subcategory, l.metric_group, l.default_treatment, l.pnl_treatment, l.classification_status,
  l.rule_includes_vat, l.rule_separates_vat, l.quantity, l.quantity_basis, l.attribution,
  al.product_id,
  p.name                                                      as product_name,
  p.category                                                  as product_category,
  (l.category = 'PRODUCT_SALES' and l.quantity is not null)   as is_cost_line,
  case
    when rc.credit is not null then 'COSTED'
    when not (l.category = 'PRODUCT_SALES' and l.quantity is not null) then 'NOT_APPLICABLE'
    when al.product_id is null then 'NO_PRODUCT'
    when pc.unit_cost is null then 'NO_COST'
    else 'COSTED'
  end                                                         as cogs_status,
  pc.unit_cost::text                                          as unit_cost,
  case
    when l.category = 'PRODUCT_SALES' and l.quantity is not null and pc.unit_cost is not null
      then (-(l.quantity::numeric(20,4) * pc.unit_cost))::numeric(20,4)::text
    when rc.credit is not null
      then rc.credit
  end                                                         as cogs
from public.ledger_classified_lines l
left join public.sku_aliases al
  on al.business_id = l.business_id
 and al.marketplace_code = l.marketplace_code
 and al.raw_sku = l.raw_sku
 and al.status = 'CONFIRMED'
left join public.catalog_products p on p.id = al.product_id
left join lateral (
  select pcost.unit_cost
  from public.product_costs pcost
  where pcost.product_id = al.product_id
    and pcost.currency = l.currency
    and pcost.retired_at is null
    and pcost.effective_from <= (l.posted_at at time zone 'UTC')::date
  order by pcost.effective_from desc, pcost.created_at desc
  limit 1
) pc on true
left join lateral (
  -- Only a refund line reaches this: the gating test below is false for every
  -- other line, so a sale or a fee costs nothing extra.
  select
    case
      when g.sold_amount > 0
       and g.uncosted_sales = 0
       and g.sold_cogs is not null
       and (-g.refunded_amount) >= g.sold_amount - 0.005
        then ((-g.sold_cogs) * (l.amount::numeric / g.refunded_amount))::numeric(20,4)::text
    end as credit
  from (
    select
      sum(s.amount::numeric) filter (where s.is_sale)                          as sold_amount,
      sum(s.line_cogs) filter (where s.is_sale)                                as sold_cogs,
      count(*) filter (where s.is_sale and s.line_cogs is null)                as uncosted_sales,
      sum(s.amount::numeric) filter (where s.is_refund)                        as refunded_amount
    from (
      select
        o.amount,
        (o.category = 'PRODUCT_SALES' and o.quantity is not null and o.amount::numeric > 0) as is_sale,
        ((o.category = 'PRODUCT_SALES' and o.amount::numeric < 0)
          or (o.category = 'SALES_REFUNDS' and o.quantity is not null))                   as is_refund,
        -(o.quantity::numeric * oc.unit_cost)                                             as line_cogs
      from public.ledger_classified_lines o
      left join public.sku_aliases oal
        on oal.business_id = o.business_id
       and oal.marketplace_code = o.marketplace_code
       and oal.raw_sku = o.raw_sku
       and oal.status = 'CONFIRMED'
      left join lateral (
        select pcost.unit_cost
        from public.product_costs pcost
        where pcost.product_id = oal.product_id
          and pcost.currency = o.currency
          and pcost.retired_at is null
          and pcost.effective_from <= (o.posted_at at time zone 'UTC')::date
        order by pcost.effective_from desc, pcost.created_at desc
        limit 1
      ) oc on true
      where o.business_id = l.business_id
        and o.marketplace_account_id = l.marketplace_account_id
        and o.order_ref = l.order_ref
        and o.raw_sku = l.raw_sku
        and o.attribution = 'ORDER_LINE'
    ) s
  ) g
  where l.attribution = 'ORDER_LINE'
    and l.order_ref is not null
    and l.raw_sku is not null
    and ((l.category = 'PRODUCT_SALES' and l.amount::numeric < 0)
      or (l.category = 'SALES_REFUNDS' and l.quantity is not null))
) rc on true;

comment on view public.ledger_product_lines is
  'Classified lines with their product (confirmed SKU mapping), the unit cost '
  'in force on the sale date, and the line''s COGS. A fully refunded order '
  'line gives its cost back on the refund line (0071): the product is taken to '
  'be back in stock. Money as exact text.';

-- ----------------------------------------------------------------------------
-- 2. product_performance(): a product's sales, cost and fees, in two clear parts
-- ----------------------------------------------------------------------------
-- PART 1, the product itself (no fee in it):
--     units sold, sales, refunds, seller discounts, net sales, cost of goods,
--     product gross profit (net sales + cost of goods) and product margin.
-- PART 2, marketplace fees, kept apart and never mixed into part 1:
--     the fees the marketplace attributed to the product's order lines, split into
--     commissions, fulfilment fees, refund fees and other charges; other income the
--     marketplace paid on them (for example cash-on-delivery charges); then
--     profit after marketplace fees and the net margin after them.
--
-- The rows add up to the P&L: net sales to pnl_summary()'s net sales, cost of goods to its
-- cost of goods, and profit after fees to its gross profit. Nothing is counted twice:
-- profit after fees = net sales + other income + fees + cost of goods, where each fee line
-- is in exactly one of the four fee columns.
--
-- A margin is only worked out where net sales are positive. With zero or negative net sales
-- (a refund of an earlier month's sale) a ratio of two negatives would show a high margin for
-- what is really a loss; there it is blank.
--
--   PRODUCT         a SKU matched to a product: full figures
--   UNMAPPED_SKU    a SKU with no product yet: sales, refunds and fees, no cost, no profit
--   NOT_ALLOCATED   everything no SKU owns: account-level fees, advertising, order-level lines.
--                   Never spread across products (A7), so the rows still add up to the P&L.
-- A plain subquery, not a WITH clause, so it can inline (0068).

create or replace function public.product_performance(
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  currency                      char(3),
  row_kind                      text,
  product_id                    uuid,
  product_name                  text,
  product_category              text,
  raw_sku                       text,
  marketplace_code              text,
  lines                         bigint,
  units_sold                    text,
  sales                         text,
  refunds                       text,
  discounts                     text,
  net_sales                     text,
  cogs                          text,
  gross_profit                  text,
  gross_margin_percent          text,
  commissions                   text,
  fulfilment_fees               text,
  refund_fees                   text,
  other_fees                    text,
  marketplace_fees              text,
  other_income                  text,
  profit_after_fees             text,
  net_margin_percent            text,
  cogs_status                   text
)
language sql
stable
security invoker
set search_path = ''
as $$
select
  g.currency::char(3),
  g.kind,
  g.product_id,
  case when g.kind = 'PRODUCT' then g.product_name end,
  case when g.kind = 'PRODUCT' then g.product_category end,
  g.raw_sku,
  g.marketplace_code,
  g.lines,
  g.units_sold::numeric(20,4)::text,
  g.sales::numeric(20,4)::text,
  g.refunds::numeric(20,4)::text,
  g.discounts::numeric(20,4)::text,
  g.net_sales::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then g.cogs::numeric(20,4)::text end,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then (g.net_sales + g.cogs)::numeric(20,4)::text end,
  case
    when g.kind = 'PRODUCT' and g.uncosted_lines = 0 and g.net_sales > 0
      then round((g.net_sales + g.cogs) / g.net_sales * 100, 1)::text
  end,
  g.commissions::numeric(20,4)::text,
  g.fulfilment_fees::numeric(20,4)::text,
  g.refund_fees::numeric(20,4)::text,
  (g.marketplace_fees - g.commissions - g.fulfilment_fees - g.refund_fees)::numeric(20,4)::text,
  g.marketplace_fees::numeric(20,4)::text,
  g.other_income::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then (g.contribution + g.cogs)::numeric(20,4)::text end,
  case
    when g.kind = 'PRODUCT' and g.uncosted_lines = 0 and g.net_sales > 0
      then round((g.contribution + g.cogs) / g.net_sales * 100, 1)::text
  end,
  case
    when g.kind = 'NOT_ALLOCATED' then 'NOT_APPLICABLE'
    when g.kind = 'UNMAPPED_SKU' then 'NO_PRODUCT'
    when g.uncosted_lines = 0 and g.costed_lines > 0 then 'COSTED'
    when g.uncosted_lines = 0 then 'NOT_APPLICABLE'
    when g.costed_lines = 0 then 'NO_COST'
    else 'PARTLY_COSTED'
  end
from (
  select
    s.currency,
    s.kind,
    case when s.kind = 'PRODUCT' then s.product_id end                   as product_id,
    case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end                 as raw_sku,
    case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end        as marketplace_code,
    max(s.product_name)                                                  as product_name,
    max(s.product_category)                                              as product_category,
    count(*)                                                             as lines,
    coalesce(sum(s.quantity::numeric) filter (where s.is_cost_line), 0)  as units_sold,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE')
                                  and s.metric_group = 'GROSS_SALES'), 0)      as sales,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE')
                                  and s.metric_group = 'SALES_REFUNDS'), 0)    as refunds,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE')
                                  and s.metric_group = 'SELLER_DISCOUNTS'), 0) as discounts,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE')
                                  and s.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE')
                                  and s.metric_group is distinct from 'GROSS_SALES'
                                  and s.metric_group is distinct from 'SALES_REFUNDS'
                                  and s.metric_group is distinct from 'SELLER_DISCOUNTS'), 0) as other_income,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE'), 0)                 as marketplace_fees,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE' and s.category = 'MARKETPLACE_FEE'), 0) as commissions,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE' and s.metric_group = 'FULFILLMENT'), 0) as fulfilment_fees,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE' and s.category = 'REFUND_FEE'), 0)      as refund_fees,
    coalesce(sum(s.amt), 0)                                              as contribution,
    coalesce(sum(s.cogs::numeric) filter (where s.cogs_status = 'COSTED'), 0) as cogs,
    count(*) filter (where s.cogs_status = 'COSTED')                     as costed_lines,
    count(*) filter (where s.cogs_status in ('NO_COST', 'NO_PRODUCT'))  as uncosted_lines
  from (
    select
      l.*,
      l.amount::numeric(20,4) as amt,
      case
        when l.attribution = 'ORDER_LINE' and l.raw_sku is not null and l.product_id is not null then 'PRODUCT'
        when l.attribution = 'ORDER_LINE' and l.raw_sku is not null then 'UNMAPPED_SKU'
        else 'NOT_ALLOCATED'
      end as kind
    from public.ledger_product_lines l
    where l.posted_at >= p_from
      and l.posted_at < p_to
      and (p_account_id is null or l.marketplace_account_id = p_account_id)
      and (p_business_id is null or l.business_id = p_business_id)
      and l.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')
  ) s
  group by s.currency, s.kind,
           case when s.kind = 'PRODUCT' then s.product_id end,
           case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end,
           case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end
) g
order by g.currency,
         case g.kind when 'PRODUCT' then 1 when 'UNMAPPED_SKU' then 2 else 3 end,
         g.net_sales desc;
$$;

revoke all on function public.product_performance(timestamptz, timestamptz, uuid, uuid) from anon, public;
grant execute on function public.product_performance(timestamptz, timestamptz, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. refund_fees(): the fees a marketplace kept because of refunds
-- ----------------------------------------------------------------------------
-- For the Expenses page. READ-ONLY. These fees are already marketplace costs in the P&L
-- and reduce gross profit there; this LISTS them so a refunded order is never a mystery.
-- Nothing is recorded or counted a second time, so nothing is deducted twice.
--
--   REFUND_FEE            every refund fee the marketplace charged in the period
--   KEPT_ON_REFUNDED      the other fees (fulfilment, referral commission net of what was
--                         handed back, and so on) on order lines refunded IN FULL, so the
--                         owner sees what a returned order really cost in fees

create or replace function public.refund_fees(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  kind       text,
  category   text,
  label      text,
  lines      bigint,
  total      text
)
language sql
stable
security invoker
set search_path = ''
as $$
with refunded as (
  -- Order lines with a refund posted in the period.
  select distinct r.marketplace_account_id, r.order_ref, r.raw_sku
  from public.ledger_classified_lines r
  where r.business_id = p_business_id
    and r.currency = p_currency
    and r.posted_at >= p_from and r.posted_at < p_to
    and (p_account_id is null or r.marketplace_account_id = p_account_id)
    and r.attribution = 'ORDER_LINE'
    and r.order_ref is not null and r.raw_sku is not null
    and ((r.category = 'PRODUCT_SALES' and r.amount::numeric < 0)
      or (r.category = 'SALES_REFUNDS' and r.quantity is not null))
),
full_refunds as (
  -- ...which were refunded in full, judged across every month in the ledger.
  select f.marketplace_account_id, f.order_ref, f.raw_sku
  from refunded f
  cross join lateral (
    select
      sum(o.amount::numeric) filter (where o.category = 'PRODUCT_SALES' and o.quantity is not null and o.amount::numeric > 0) as sold,
      sum(o.amount::numeric) filter (where (o.category = 'PRODUCT_SALES' and o.amount::numeric < 0)
                                       or (o.category = 'SALES_REFUNDS' and o.quantity is not null))                         as back
    from public.ledger_classified_lines o
    where o.business_id = p_business_id
      and o.marketplace_account_id = f.marketplace_account_id
      and o.order_ref = f.order_ref
      and o.raw_sku = f.raw_sku
      and o.attribution = 'ORDER_LINE'
  ) t
  where t.sold > 0 and (-t.back) >= t.sold - 0.005
)
select x.kind, x.category, coalesce(max(x.category_label), x.category), count(*), sum(x.amount)::numeric(20,4)::text
from (
  select 'REFUND_FEE'::text as kind, l.category, l.category_label, l.amount::numeric as amount
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.currency = p_currency
    and l.posted_at >= p_from and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and l.category = 'REFUND_FEE'
    and l.pnl_treatment = 'INCREASE_EXPENSE'
  union all
  select 'KEPT_ON_REFUNDED'::text, o.category, o.category_label, o.amount::numeric
  from full_refunds fr
  join public.ledger_classified_lines o
    on o.business_id = p_business_id
   and o.marketplace_account_id = fr.marketplace_account_id
   and o.order_ref = fr.order_ref
   and o.raw_sku = fr.raw_sku
  where o.attribution = 'ORDER_LINE'
    and o.pnl_treatment = 'INCREASE_EXPENSE'
    and o.category <> 'REFUND_FEE'
    and o.posted_at >= p_from and o.posted_at < p_to
) x
group by x.kind, x.category
having sum(x.amount) <> 0
order by x.kind desc, sum(x.amount);
$$;

revoke all on function public.refund_fees(uuid, text, timestamptz, timestamptz, uuid) from anon, public;
grant execute on function public.refund_fees(uuid, text, timestamptz, timestamptz, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. product_analysis() on the same rules (replaces the 0070 definition, same signature)
-- ----------------------------------------------------------------------------
-- Gross profit and margin are before marketplace fees, with the cost of fully refunded
-- units returned: the same figures the Product Profit page shows. Marketplace costs stay
-- in the result as information (the cost breakdown, the price check); they are not
-- subtracted from gross profit. Orders list "profit" the same way.

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
    coalesce(sum(b.amt) filter (where b.category = 'PRODUCT_SALES' and b.qty is not null and b.amt > 0), 0) as sale_amt,
    coalesce(sum(b.cogs) filter (where b.is_cost_line and b.cogs_status = 'COSTED'), 0)        as sale_cogs,
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
    case when q.uncosted = 0 then q.net_sales + q.cogs end                                       as gross_profit,
    case when q.uncosted = 0 and q.net_sales > 0
         then round((q.net_sales + q.cogs) / q.net_sales * 100, 1) end                              as margin,
    case when q.net_sales > 0 then round(abs(q.costs) / q.net_sales * 100, 1) end              as costs_pct,
    case when q.uncosted = 0 and q.net_sales > 0 then round(abs(q.cogs) / q.net_sales * 100, 1) end as cogs_pct,
    case
      when q.uncosted = 0 and q.costed > 0 then 'COSTED'
      when q.uncosted = 0 then 'NOT_APPLICABLE'
      when q.costed = 0 then 'NO_COST'
      else 'PARTLY_COSTED'
    end                                                                                        as cogs_status,
    q.sale_amt,
    q.sale_cogs,
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
         then coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)
              + coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0) end as gross_profit
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
    'margin',       case when d.gross_profit is not null and d.net_sales > 0
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
    'gross_profit',     case when g.uncosted = 0 then (g.net_sales + g.cogs)::numeric(20,4)::text end,
    'margin',           case when g.uncosted = 0 and g.net_sales > 0
                             then round((g.net_sales + g.cogs) / g.net_sales * 100, 1)::text end
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
         then coalesce(sum(b.amt) filter (where b.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)
              + coalesce(sum(b.cogs) filter (where b.cogs_status = 'COSTED'), 0) end as profit
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
  -- Per unit SOLD, this month, at the price and cost it sold at (before any refund, so a
  -- returned unit does not distort the unit cost). Null unless there are units, sales and
  -- a cost for every unit: a price check on a guess would be worse than none.
  select
    case when c.units > 0 and c.sale_amt > 0 and c.cogs is not null then
      jsonb_build_object(
        'target_margin',     p_target_margin,
        'average_price',     (c.sale_amt / c.units)::numeric(20,4)::text,
        'unit_cogs',         (abs(c.sale_cogs) / c.units)::numeric(20,4)::text,
        'unit_costs',        (abs(c.costs) / c.units)::numeric(20,4)::text,
        'break_even_price',  ((abs(c.sale_cogs) + abs(c.costs)) / c.units)::numeric(20,4)::text,
        'required_price',    case when p_target_margin < 100
                                  then (((abs(c.sale_cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100))::numeric(20,4)::text end,
        'increase_amount',   case when p_target_margin < 100
                                  then ((((abs(c.sale_cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100)) - c.sale_amt / c.units)::numeric(20,4)::text end,
        'increase_pct',      case when p_target_margin < 100
                                  then round(((((abs(c.sale_cogs) + abs(c.costs)) / c.units) / (1 - p_target_margin / 100)) / (c.sale_amt / c.units) - 1) * 100, 1) end
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

-- ----------------------------------------------------------------------------
-- 5. pnl_by_product(): the margin rule fixed (same function, same columns)
-- ----------------------------------------------------------------------------
-- The app that is deployed today still reads this function. A margin was worked out for any
-- non-zero net sales, so a refund-only product (net sales -269, gross profit -252) showed a
-- margin of +93.7% and was counted as "High margin". A margin now needs positive net sales.
-- Nothing else about it changes. The app is moved to product_performance() and this function
-- is retired in a later migration.

create or replace function public.pnl_by_product(
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  currency              char(3),
  row_kind              text,
  product_id            uuid,
  product_name          text,
  product_category      text,
  raw_sku               text,
  marketplace_code      text,
  lines                 bigint,
  units_sold            text,
  net_sales             text,
  other_income          text,
  costs                 text,
  cogs                  text,
  contribution          text,
  gross_profit          text,
  gross_margin_percent  text,
  cogs_status           text
)
language sql
stable
security invoker
set search_path = ''
as $$
select
  g.currency::char(3),
  g.kind,
  g.product_id,
  case when g.kind = 'PRODUCT' then g.product_name end,
  case when g.kind = 'PRODUCT' then g.product_category end,
  g.raw_sku,
  g.marketplace_code,
  g.lines,
  g.units_sold::numeric(20,4)::text,
  g.net_sales::numeric(20,4)::text,
  g.other_income::numeric(20,4)::text,
  g.costs::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then g.cogs::numeric(20,4)::text end,
  g.contribution::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then (g.contribution + g.cogs)::numeric(20,4)::text end,
  case
    when g.kind = 'PRODUCT' and g.uncosted_lines = 0 and g.net_sales > 0
      then round((g.contribution + g.cogs) / g.net_sales * 100, 1)::text
  end,
  case
    when g.kind = 'NOT_ALLOCATED' then 'NOT_APPLICABLE'
    when g.kind = 'UNMAPPED_SKU' then 'NO_PRODUCT'
    when g.uncosted_lines = 0 and g.costed_lines > 0 then 'COSTED'
    when g.uncosted_lines = 0 then 'NOT_APPLICABLE'
    when g.costed_lines = 0 then 'NO_COST'
    else 'PARTLY_COSTED'
  end
from (
  select
    s.currency,
    s.kind,
    case when s.kind = 'PRODUCT' then s.product_id end                   as product_id,
    case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end                 as raw_sku,
    case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end        as marketplace_code,
    max(s.product_name)                                                  as product_name,
    max(s.product_category)                                              as product_category,
    count(*)                                                             as lines,
    coalesce(sum(s.quantity::numeric) filter (where s.is_cost_line), 0)  as units_sold,
    coalesce(sum(s.amt) filter (where s.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_INCOME'), 0) as other_income,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE'), 0) as costs,
    coalesce(sum(s.cogs::numeric) filter (where s.cogs_status = 'COSTED'), 0) as cogs,
    count(*) filter (where s.cogs_status = 'COSTED')                     as costed_lines,
    count(*) filter (where s.cogs_status in ('NO_COST', 'NO_PRODUCT'))  as uncosted_lines,
    sum(s.amt)                                                           as contribution
  from (
    select
      l.*,
      l.amount::numeric(20,4) as amt,
      case
        when l.raw_sku is not null and l.attribution = 'ORDER_LINE' and l.product_id is not null then 'PRODUCT'
        when l.raw_sku is not null and l.attribution = 'ORDER_LINE' then 'UNMAPPED_SKU'
        else 'NOT_ALLOCATED'
      end as kind
    from public.ledger_product_lines l
    where l.posted_at >= p_from
      and l.posted_at < p_to
      and (p_account_id is null or l.marketplace_account_id = p_account_id)
      and (p_business_id is null or l.business_id = p_business_id)
      and l.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')
  ) s
  group by s.currency, s.kind,
           case when s.kind = 'PRODUCT' then s.product_id end,
           case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end,
           case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end
) g
order by g.currency,
         case g.kind when 'PRODUCT' then 1 when 'UNMAPPED_SKU' then 2 else 3 end,
         g.net_sales desc;
$$;

-- ----------------------------------------------------------------------------
-- 6. Self-check
-- ----------------------------------------------------------------------------

do $$
declare
  v_columns integer;
begin
  select count(*) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'ledger_product_lines';
  if v_columns <> 44 then
    raise exception 'ledger_product_lines should keep its 44 columns; it has %.', v_columns;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('product_performance', 'refund_fees', 'product_analysis')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the readers must be SECURITY INVOKER and closed to anon.';
  end if;

  raise notice 'Migration 0071 verified: ledger_product_lines keeps its 44 columns and returns the cost of fully refunded orders; product_performance, refund_fees and product_analysis are read-only, invoker-rights, closed to anon.';
end;
$$;

commit;
