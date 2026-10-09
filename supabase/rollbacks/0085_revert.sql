-- ============================================================================
-- UNDO for 0085: the 0069 view and the 0076 pnl_summary() come back, exactly.
-- Run in the Supabase SQL editor (clear it first: Ctrl+A, Delete). Read-only objects; no data touched.
-- ============================================================================

begin;

create or replace view public.ledger_classified_lines
with (security_invoker = true)
as
select
  ft.id,
  ft.business_id,
  ft.marketplace_account_id,
  a.marketplace_code,
  a.label                                        as account_label,
  ft.source_file_id,
  b.format_id,
  ft.source_row_id,
  ft.line_index,
  public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
  ft.source_type,
  ft.source_subtype,
  ft.source_description,
  ft.amount::text                                as amount,
  ft.currency,
  ft.posted_at,
  ft.order_ref,
  ft.raw_sku,
  ft.side                                        as import_side,
  ft.category                                    as import_category,
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
  coalesce(r.separates_included_vat, false)      as rule_separates_vat,
  ft.quantity::text                              as quantity,
  ft.quantity_basis,
  ft.attribution,
  ft.external_ref
from public.financial_transactions ft
join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
join public.marketplace_accounts a on a.id = ft.marketplace_account_id
left join public.tax_profiles tp on tp.marketplace_account_id = ft.marketplace_account_id
left join lateral (
  select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory,
         cr.amount_includes_vat, cr.separates_included_vat
  from public.classification_rules cr
  where cr.status = 'ACTIVE'
    and cr.marketplace_code = a.marketplace_code
    and cr.format_id = b.format_id
    and cr.match_key = public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
    and (cr.business_id is null or cr.business_id = ft.business_id)
  order by case
             when cr.business_id is null and cr.confidence = 'HIGH' then 1
             when cr.business_id is not null then 2
             else 3
           end
  limit 1
) r on true
left join public.classification_categories c on c.code = r.category;

create or replace function public.pnl_summary(
  p_from                 timestamptz,
  p_to                   timestamptz,
  p_account_id           uuid default null,
  p_business_id          uuid default null,
  p_combine_by_currency  boolean default false
)
returns table (
  marketplace_account_id          uuid,
  account_label                   text,
  marketplace_code                text,
  currency                        char(3),
  period_from                     timestamptz,
  period_to                       timestamptz,
  gross_sales                     text,
  sales_refunds                   text,
  seller_discounts                text,
  net_sales                       text,
  other_income                    text,
  marketplace_fees                text,
  fulfillment                     text,
  advertising                     text,
  other_marketplace_costs         text,
  non_recoverable_vat             text,
  contribution                    text,
  contribution_status             text,
  contribution_before_open_items  text,
  figures_status                  text,
  input_vat_recoverable           text,
  input_vat_unresolved            text,
  output_vat                      text,
  input_vat_treatment             text,
  lines                           bigint,
  unknown_lines                   bigint,
  unknown_amount                  text,
  review_lines                    bigint,
  review_amount                   text,
  conditional_lines               bigint,
  row_errors                      bigint,
  incomplete_reasons              text[],
  accounts                        bigint,
  units_sold                      text,
  cogs                            text,
  units_without_product           text,
  units_without_cost              text,
  sales_without_cost              text,
  gross_profit                    text,
  gross_profit_status             text,
  gross_profit_before_open_items  text,
  gross_profit_reasons            text[],
  -- 0052: additive KPIs, every marketplace, same reporting model.
  orders                          bigint,
  average_order_value             text,
  profit_per_order                text,
  gross_margin_pct                numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  -- Only the columns the totals below use, not all 44 of the view: every line used to be
  -- copied in full into a temporary table (it was read twice), which spilled to disk on a
  -- long range. Read once now, below.
  select
    l.marketplace_account_id, l.account_label, l.marketplace_code, l.currency, l.source_file_id,
    l.metric_group, l.pnl_treatment, l.classification_status, l.rule_includes_vat,
    l.rule_separates_vat, l.quantity, l.is_cost_line, l.cogs, l.cogs_status, l.order_ref,
    l.amount::numeric(20,4) as amt
  from public.ledger_product_lines l
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
per_account as (
  select
    s.marketplace_account_id,
    s.account_label,
    s.marketplace_code,
    s.currency,
    coalesce(sum(s.amt) filter (where s.metric_group = 'GROSS_SALES'), 0)             as gross_sales,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SALES_REFUNDS'), 0)           as sales_refunds,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SELLER_DISCOUNTS'), 0)        as seller_discounts,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_INCOME'), 0)            as other_income,
    coalesce(sum(s.amt) filter (where s.metric_group = 'MARKETPLACE_FEES'), 0)        as marketplace_fees,
    coalesce(sum(s.amt) filter (where s.metric_group = 'FULFILLMENT'), 0)             as fulfillment,
    coalesce(sum(s.amt) filter (where s.metric_group = 'ADVERTISING'), 0)             as advertising,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_MARKETPLACE_COSTS'), 0) as other_costs,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'INCREASE_EXPENSE'), 0)        as nonrec_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'NO_PNL_IMPACT'), 0)           as rec_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'CONDITIONAL'), 0)            as unresolved_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OUTPUT_VAT'), 0)              as output_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in
      ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)                as pnl_known,
    count(*)                                                                         as lines,
    count(*) filter (where s.classification_status = 'UNKNOWN')                      as unknown_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNKNOWN'), 0)        as unknown_amount,
    count(*) filter (where s.classification_status = 'UNDER_REVIEW')                 as review_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNDER_REVIEW'), 0)   as review_amount,
    count(*) filter (where s.pnl_treatment = 'CONDITIONAL')                          as conditional_lines,
    (bool_or(s.rule_includes_vat) and not bool_or(s.rule_separates_vat))             as vat_inside_fees,
    coalesce(sum(s.quantity::numeric) filter (where s.is_cost_line), 0)               as units_sold,
    coalesce(sum(s.cogs::numeric) filter (where s.cogs_status = 'COSTED'), 0)          as cogs,
    coalesce(sum(s.quantity::numeric) filter (where s.cogs_status = 'NO_PRODUCT'), 0) as units_no_product,
    coalesce(sum(s.quantity::numeric) filter (where s.cogs_status = 'NO_COST'), 0)    as units_no_cost,
    coalesce(sum(s.amt) filter (where s.cogs_status in ('NO_PRODUCT', 'NO_COST')), 0) as sales_uncosted,
    -- 0052: an order counts once even when it has several lines (principal,
    -- shipping, several SKUs). Lines with no order reference are not orders.
    count(distinct s.order_ref) filter (where s.metric_group = 'GROSS_SALES' and s.order_ref is not null) as orders,
    array_agg(distinct s.source_file_id) as file_ids
  from scoped s
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency
),
errors as (
  -- The same count as before: the ERROR row issues of every file the account's lines came from.
  select pa.marketplace_account_id, count(*) as n
  from per_account pa
  cross join lateral unnest(pa.file_ids) as f(source_file_id)
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by pa.marketplace_account_id
),
judged_account as (
  select
    pa.*,
    coalesce(e.n, 0)                                          as row_error_count,
    coalesce(tp.input_vat_treatment, 'UNKNOWN')               as vat_setting,
    (pa.vat_inside_fees
      and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE') as vat_not_separated
  from per_account pa
  left join errors e on e.marketplace_account_id = pa.marketplace_account_id
  left join public.tax_profiles tp on tp.marketplace_account_id = pa.marketplace_account_id
),
grouped as (
  select
    case when p_combine_by_currency then null else j.marketplace_account_id end as account_id,
    j.currency,
    case when p_combine_by_currency then 'All ' || j.currency || ' accounts' else min(j.account_label) end as label,
    case when count(distinct j.marketplace_code) = 1 then min(j.marketplace_code) else 'MIXED' end as code,
    case when count(distinct j.vat_setting) = 1 then min(j.vat_setting) else 'MIXED' end as vat_setting,
    sum(j.gross_sales) as gross_sales, sum(j.sales_refunds) as sales_refunds,
    sum(j.seller_discounts) as seller_discounts, sum(j.other_income) as other_income,
    sum(j.marketplace_fees) as marketplace_fees, sum(j.fulfillment) as fulfillment,
    sum(j.advertising) as advertising, sum(j.other_costs) as other_costs,
    sum(j.nonrec_vat) as nonrec_vat, sum(j.rec_vat) as rec_vat,
    sum(j.unresolved_vat) as unresolved_vat, sum(j.output_vat) as output_vat,
    sum(j.pnl_known) as pnl_known,
    sum(j.lines)::bigint as lines, sum(j.unknown_lines)::bigint as unknown_lines,
    sum(j.unknown_amount) as unknown_amount, sum(j.review_lines)::bigint as review_lines,
    sum(j.review_amount) as review_amount, sum(j.conditional_lines)::bigint as conditional_lines,
    sum(j.row_error_count)::bigint as row_error_count,
    bool_or(j.vat_not_separated) as vat_not_separated,
    count(*)::bigint as accounts,
    sum(j.units_sold) as units_sold,
    sum(j.cogs) as cogs,
    sum(j.units_no_product) as units_no_product,
    sum(j.units_no_cost) as units_no_cost,
    sum(j.sales_uncosted) as sales_uncosted,
    sum(j.orders)::bigint as orders
  from judged_account j
  group by case when p_combine_by_currency then null else j.marketplace_account_id end, j.currency
),
judged as (
  select
    g.*,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated) as figures_incomplete,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated
      or g.conditional_lines > 0)                                        as contribution_incomplete,
    array_remove(array[
      case when g.unknown_lines > 0 then 'UNKNOWN_LINES' end,
      case when g.conditional_lines > 0 then 'VAT_TREATMENT_UNKNOWN' end,
      case when g.vat_not_separated then 'FEE_VAT_NOT_SEPARATED' end,
      case when g.row_error_count > 0 then 'ROW_ERRORS' end
    ], null)                                                             as reasons,
    (g.gross_sales + g.sales_refunds + g.seller_discounts)                as net_sales
  from grouped g
)
select
  j.account_id,
  j.label,
  j.code,
  j.currency::char(3),
  p_from,
  p_to,
  j.gross_sales::numeric(20,4)::text,
  j.sales_refunds::numeric(20,4)::text,
  j.seller_discounts::numeric(20,4)::text,
  j.net_sales::numeric(20,4)::text,
  j.other_income::numeric(20,4)::text,
  j.marketplace_fees::numeric(20,4)::text,
  j.fulfillment::numeric(20,4)::text,
  j.advertising::numeric(20,4)::text,
  j.other_costs::numeric(20,4)::text,
  j.nonrec_vat::numeric(20,4)::text,
  case when j.contribution_incomplete then null else j.pnl_known::numeric(20,4)::text end,
  case when j.contribution_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.pnl_known::numeric(20,4)::text,
  case when j.figures_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.rec_vat::numeric(20,4)::text,
  j.unresolved_vat::numeric(20,4)::text,
  j.output_vat::numeric(20,4)::text,
  j.vat_setting,
  j.lines,
  j.unknown_lines,
  j.unknown_amount::numeric(20,4)::text,
  j.review_lines,
  j.review_amount::numeric(20,4)::text,
  j.conditional_lines,
  j.row_error_count,
  j.reasons,
  j.accounts,
  j.units_sold::numeric(20,4)::text,
  j.cogs::numeric(20,4)::text,
  j.units_no_product::numeric(20,4)::text,
  j.units_no_cost::numeric(20,4)::text,
  j.sales_uncosted::numeric(20,4)::text,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then null
    else (j.pnl_known + j.cogs)::numeric(20,4)::text
  end,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then 'INCOMPLETE'
    else 'FINAL'
  end,
  (j.pnl_known + j.cogs)::numeric(20,4)::text,
  j.reasons || array_remove(array[
    case when j.units_no_product > 0 then 'SKU_NOT_MAPPED' end,
    case when j.units_no_cost > 0 then 'COST_MISSING' end
  ], null),
  -- 0052
  j.orders,
  case when j.orders > 0 then (j.net_sales / j.orders)::numeric(20,4)::text end,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 or j.orders = 0 then null
    else ((j.pnl_known + j.cogs) / j.orders)::numeric(20,4)::text
  end,
  public.dashboard_pct(
    case when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then null
         else (j.pnl_known + j.cogs) end,
    j.net_sales
  )
from judged j
order by j.currency, j.label;
$$;

revoke all on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) from anon, public;
grant execute on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) to authenticated;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'ledger_classified_lines') <> 38 then
    raise exception 'UNDO 0085: ledger_classified_lines column count is not 38.';
  end if;
  raise notice 'Undo 0085 verified: the 0069 view and the 0076 pnl_summary are back.';
end;
$$;

commit;
