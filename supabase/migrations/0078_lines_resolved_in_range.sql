-- ============================================================================
-- 0078  Classified lines for a period, each line TYPE classified once (for an exact comparison)
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- WHAT THE MEASUREMENT SHOWED (perf_explain, 0077, on the real ledger, everything already
-- in memory, so the slow disk is NOT the problem):
--
--     reading the stored lines of Jan-Aug ........................  35 ms
--     the same lines through ledger_classified_lines ............. 1,900 ms
--     the same through ledger_product_lines ...................... 2,100 ms
--     product_performance() for Jan-Aug ......................... 5,000 ms
--
-- The time is spent working out, for EVERY line, which classification rule applies, by a
-- look-up that touches ~10 memory pages per line. Yet the rule depends only on the line's
-- account, its file's format and its TYPE (a few dozen distinct types in a month). 0065
-- once tried to fix this inside the view and had to be reverted (0069) because a view
-- cannot be told the period, so the type step scanned the whole ledger. A FUNCTION can be
-- told the period, so the types are found and classified for that period only.
--
-- This migration ADDS (nothing existing is touched or replaced):
--   ledger_lines_resolved(business, from, to)      the same rows, same columns, same values as
--                                                  ledger_classified_lines for that period, with
--                                                  each line type classified once
--   ledger_product_lines_in(business, from, to)    the same as ledger_product_lines (0073), built
--                                                  on the function above
--   perf_compare_lines(business, from, to)         runs old and new on one period, compares EVERY
--                                                  column of EVERY line, and times both
-- Both new functions return the very row type of the existing views, so their columns and
-- types cannot differ. The rule choice, tie-break order, tax-profile treatment, status
-- rules and flags are copied verbatim from 0057/0069 (the current view).
--
-- Nothing reads them yet. They are used by the pages only when perf_compare_lines() shows
-- zero differing lines for every month and they are faster. All three are read-only,
-- SECURITY INVOKER (row level security applies exactly as for any user), closed to anon.
-- NOTE: a later change to the columns of ledger_classified_lines / ledger_product_lines
-- must rebuild these two functions (they return those row types).
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. ledger_lines_resolved
-- ----------------------------------------------------------------------------

create or replace function public.ledger_lines_resolved(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns setof public.ledger_classified_lines
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as not materialized (
  -- The lines of the period, with the same joins the view makes (a withdrawn file's lines are out).
  select
    ft.id, ft.business_id, ft.marketplace_account_id, ft.source_file_id, ft.source_row_id, ft.line_index,
    ft.source_type, ft.source_subtype, ft.source_description, ft.amount, ft.currency, ft.posted_at,
    ft.order_ref, ft.raw_sku, ft.side, ft.category, ft.quantity, ft.quantity_basis, ft.attribution,
    ft.external_ref,
    b.format_id,
    a.marketplace_code,
    a.label as account_label,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where ft.posted_at >= p_from
    and ft.posted_at < p_to
    and (p_business_id is null or ft.business_id = p_business_id)
),
types as (
  -- The few distinct line types present in the period.
  select distinct s.business_id, s.marketplace_account_id, s.marketplace_code, s.format_id, s.match_key
  from scoped s
),
resolved as (
  -- Each type is classified ONCE: the identical rule look-up and treatment as the view.
  select
    t.business_id,
    t.marketplace_account_id,
    t.format_id,
    t.match_key,
    r.id                                           as rule_id,
    r.scope                                        as rule_scope,
    r.confidence                                   as rule_confidence,
    r.version                                      as rule_version,
    c.financial_type,
    r.category,
    c.label                                        as category_label,
    r.subcategory,
    c.metric_group,
    c.default_treatment,
    case
      when r.id is null then null
      when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
      when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
      when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
      else 'CONDITIONAL'
    end                                            as pnl_treatment,
    case
      when r.id is null then 'UNKNOWN'
      when r.scope = 'GLOBAL' and r.confidence = 'MEDIUM' then 'UNDER_REVIEW'
      else 'CLASSIFIED'
    end                                            as classification_status,
    coalesce(r.amount_includes_vat, false)         as rule_includes_vat,
    coalesce(r.separates_included_vat, false)      as rule_separates_vat
  from types t
  left join public.tax_profiles tp on tp.marketplace_account_id = t.marketplace_account_id
  left join lateral (
    select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory,
           cr.amount_includes_vat, cr.separates_included_vat
    from public.classification_rules cr
    where cr.status = 'ACTIVE'
      and cr.marketplace_code = t.marketplace_code
      and cr.format_id = t.format_id
      and cr.match_key = t.match_key
      and (cr.business_id is null or cr.business_id = t.business_id)
    order by case
               when cr.business_id is null and cr.confidence = 'HIGH' then 1
               when cr.business_id is not null then 2
               else 3
             end
    limit 1
  ) r on true
  left join public.classification_categories c on c.code = r.category
)
select
  s.id,
  s.business_id,
  s.marketplace_account_id,
  s.marketplace_code,
  s.account_label,
  s.source_file_id,
  s.format_id,
  s.source_row_id,
  s.line_index,
  s.match_key,
  s.source_type,
  s.source_subtype,
  s.source_description,
  s.amount::text                                   as amount,
  s.currency,
  s.posted_at,
  s.order_ref,
  s.raw_sku,
  s.side                                           as import_side,
  s.category                                       as import_category,
  r.rule_id,
  r.rule_scope,
  r.rule_confidence,
  r.rule_version,
  r.financial_type,
  r.category,
  r.category_label,
  r.subcategory,
  r.metric_group,
  r.default_treatment,
  r.pnl_treatment,
  r.classification_status,
  r.rule_includes_vat,
  r.rule_separates_vat,
  s.quantity::text                                 as quantity,
  s.quantity_basis,
  s.attribution,
  s.external_ref
from scoped s
join resolved r
  on  r.business_id = s.business_id
  and r.marketplace_account_id = s.marketplace_account_id
  and r.match_key = s.match_key
  -- A file with no format never matches a rule; null-safe, and still a plain equality for a hash join.
  and (r.format_id is null) = (s.format_id is null)
  and coalesce(r.format_id, '') = coalesce(s.format_id, '');
$$;

revoke all on function public.ledger_lines_resolved(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.ledger_lines_resolved(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. ledger_product_lines_in: ledger_product_lines (0073) over the function above
-- ----------------------------------------------------------------------------

create or replace function public.ledger_product_lines_in(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns setof public.ledger_product_lines
language sql
stable
security invoker
set search_path = ''
as $$
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
from public.ledger_lines_resolved(p_business_id, p_from, p_to) l
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
  -- Verbatim from 0073: the credit is worked out ONLY for a refund line, and looks at the
  -- order's other lines wherever they fall in time (so it reads the whole-ledger view).
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
$$;

revoke all on function public.ledger_product_lines_in(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.ledger_product_lines_in(uuid, timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. perf_compare_lines: old against new, line for line, every column
-- ----------------------------------------------------------------------------

create or replace function public.perf_compare_lines(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  what          text,
  rows_view     bigint,
  rows_func     bigint,
  only_in_view  bigint,
  only_in_func  bigint,
  ms_view       numeric,
  ms_func       numeric
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t0 timestamptz;
begin
  -- Classified lines. count(l.pnl_treatment) forces the rule columns to be worked out in both.
  what := 'classified';
  t0 := clock_timestamp();
  select count(l.pnl_treatment) into rows_view
  from public.ledger_classified_lines l
  where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to;
  ms_view := round(extract(epoch from clock_timestamp() - t0) * 1000);

  t0 := clock_timestamp();
  select count(l.pnl_treatment) into rows_func
  from public.ledger_lines_resolved(p_business_id, p_from, p_to) l;
  ms_func := round(extract(epoch from clock_timestamp() - t0) * 1000);

  select count(*) into only_in_view from (
    select * from public.ledger_classified_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to
    except all
    select * from public.ledger_lines_resolved(p_business_id, p_from, p_to)
  ) x;
  select count(*) into only_in_func from (
    select * from public.ledger_lines_resolved(p_business_id, p_from, p_to)
    except all
    select * from public.ledger_classified_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to
  ) x;
  return next;

  -- Product lines (product, unit cost, cost of goods, refund credit).
  what := 'product';
  t0 := clock_timestamp();
  select count(l.cogs_status) into rows_view
  from public.ledger_product_lines l
  where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to;
  ms_view := round(extract(epoch from clock_timestamp() - t0) * 1000);

  t0 := clock_timestamp();
  select count(l.cogs_status) into rows_func
  from public.ledger_product_lines_in(p_business_id, p_from, p_to) l;
  ms_func := round(extract(epoch from clock_timestamp() - t0) * 1000);

  select count(*) into only_in_view from (
    select * from public.ledger_product_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to
    except all
    select * from public.ledger_product_lines_in(p_business_id, p_from, p_to)
  ) x;
  select count(*) into only_in_func from (
    select * from public.ledger_product_lines_in(p_business_id, p_from, p_to)
    except all
    select * from public.ledger_product_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to
  ) x;
  return next;
end;
$$;

revoke all on function public.perf_compare_lines(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.perf_compare_lines(uuid, timestamptz, timestamptz) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ledger_lines_resolved', 'ledger_product_lines_in', 'perf_compare_lines')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the new functions must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0078 verified: ledger_lines_resolved, ledger_product_lines_in and perf_compare_lines are read-only, invoker-rights, closed to anon.';
end;
$$;

commit;
