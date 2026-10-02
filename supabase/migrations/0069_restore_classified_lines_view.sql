-- ============================================================================
-- 0069  Restore ledger_classified_lines to its 0057 definition
-- ============================================================================
-- 0065 rewrote this view to resolve classification rules once per distinct
-- line type instead of once per line. It introduced a regression: the
-- `distinct_groups` step reads `base` as a separate reference, so the date
-- filter every caller applies to the view never reaches it. Every read of the
-- view therefore scanned and sorted the business's WHOLE ledger (~45,000 rows,
-- with disk-spilling sorts) however narrow the period -- visible in the plans
-- as one scan carrying `posted_at >= ...` and the other carrying only
-- business_id and marketplace_account_id. Measured on the owner's real data,
-- 2026-10-02: pnl_summary 2.3-5.9s, ledger_data_quality 2.7s and
-- pnl_by_product 2.9-6s for a SINGLE month of ~3,000 lines, and
-- dashboard_overview (which reads the view about four times) timing out at
-- three months. Before 0065 a month cost about 3,000 small index lookups.
--
-- This restores the 0057 definition byte for byte: the same 38 columns in the
-- same order, one flat query, so a caller's date range reaches the
-- financial_transactions scan directly. Nothing about WHICH rule a line gets
-- changes. 0066, 0067 and 0068 do not depend on 0065's internals (they read
-- only the view's columns) and stay as they are.
--
-- A faster version is possible, but only if the date filter reaches the
-- line-type step; that needs to be designed and measured on a single month
-- first, not just a wide range.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
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

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'ledger_classified_lines') <> 38 then
    raise exception 'MIGRATION 0069: ledger_classified_lines column count is not 38.';
  end if;
  raise notice 'Migration 0069 verified: ledger_classified_lines restored to its 0057 definition.';
end;
$$;

commit;
