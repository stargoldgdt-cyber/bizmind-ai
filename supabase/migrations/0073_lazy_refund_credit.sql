-- ============================================================================
-- 0073  Faster refund credit (same figures, 10-20x less work)
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- Measured on the real ledger with perf_lab() (0072), a one-week window of 2,254 lines:
--
--     product lines as they were before 0071 ........ ~55 ms
--     product lines with 0071's refund credit ....... 400-1,060 ms
--
-- 0071's look-up of "what was this order's sale and what has been refunded" ran for EVERY
-- line, not only for the few refund lines. This replaces it with the same look-up behind a
-- CASE, so it runs only for a refund line. Every figure is identical: perf_lab() step 3
-- must still read the same cost of goods (-22,217.00 for 1-8 Aug 2026) as before this
-- migration, and now in a fraction of the time. Nothing else changes: the view keeps its
-- 44 columns and every dependant keeps working.
--
-- TO UNDO: run supabase/rollbacks/0073_revert.sql (puts the 0071 view back exactly).
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

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
  -- The credit is worked out ONLY for a refund line. The test sits in a CASE so the
  -- (comparatively costly) look-up of the order's other lines is not even started for a
  -- sale, a fee or any other line: measured on the real ledger, running it for every line
  -- was 10-20x slower than the view without it (0071). The figures are exactly the same.
  select
    case
      when l.attribution = 'ORDER_LINE'
       and l.order_ref is not null
       and l.raw_sku is not null
       and ((l.category = 'PRODUCT_SALES' and l.amount::numeric < 0)
         or (l.category = 'SALES_REFUNDS' and l.quantity is not null))
      then (
        select
          case
            when g.sold_amount > 0
             and g.uncosted_sales = 0
             and g.sold_cogs is not null
             and (-g.refunded_amount) >= g.sold_amount - 0.005
              then ((-g.sold_cogs) * (l.amount::numeric / g.refunded_amount))::numeric(20,4)::text
          end
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
      )
    end as credit
) rc on true;

comment on view public.ledger_product_lines is
  'Classified lines with their product (confirmed SKU mapping), the unit cost '
  'in force on the sale date, and the line''s COGS. A fully refunded order '
  'line gives its cost back on the refund line (0071): the product is taken to '
  'be back in stock. Money as exact text.';

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
  raise notice 'Migration 0073 verified: ledger_product_lines keeps its 44 columns; the refund credit now runs only for refund lines.';
end;
$$;

commit;
