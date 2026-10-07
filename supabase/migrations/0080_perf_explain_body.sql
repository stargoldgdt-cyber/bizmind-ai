-- ============================================================================
-- 0080  perf_explain(): one more fixed question, 'resolved_body' (TEMPORARY measuring tool)
-- ============================================================================
-- 0079 did not make ledger_lines_resolved() faster (still 6.5 s for 994 lines, 162,000 memory
-- pages touched: ~160 per line against ~3 per line in the old view). A function's own
-- plan cannot be seen from outside, so this adds the question 'resolved_body': the very
-- same SELECT as the function's body, run directly with the dates filled in, so EXPLAIN
-- (ANALYZE, BUFFERS) can show which step repeats. Read-only, SECURITY INVOKER, closed to
-- anon; the other questions are unchanged. Nothing else is touched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.perf_explain(
  p_which       text,
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (line text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sql text;
  r     record;
begin
  v_sql := case p_which
    when 'raw' then
      format('select count(*) from public.financial_transactions t where t.business_id = %L and t.posted_at >= %L and t.posted_at < %L',
             p_business_id, p_from, p_to)
    when 'classified' then
      format('select count(*) from public.ledger_classified_lines l where l.business_id = %L and l.posted_at >= %L and l.posted_at < %L',
             p_business_id, p_from, p_to)
    when 'product' then
      format('select count(*) from public.ledger_product_lines l where l.business_id = %L and l.posted_at >= %L and l.posted_at < %L',
             p_business_id, p_from, p_to)
    when 'resolved' then
      format('select count(l.pnl_treatment) from public.ledger_lines_resolved(%L, %L, %L) l', p_business_id, p_from, p_to)
    when 'product_in' then
      format('select count(l.cogs_status) from public.ledger_product_lines_in(%L, %L, %L) l', p_business_id, p_from, p_to)
    when 'resolved_body' then
      format($q$
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
  where ft.posted_at >= %2$L::timestamptz
    and ft.posted_at < %3$L::timestamptz
    and (%1$L::uuid is null or ft.business_id = %1$L::uuid)
),
types as materialized (
  -- The few distinct line types present in the period.
  select distinct s.business_id, s.marketplace_account_id, s.marketplace_code, s.format_id, s.match_key
  from scoped s
),
resolved as materialized (
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
  and coalesce(r.format_id, '') = coalesce(s.format_id, '')
$q$, p_business_id, p_from, p_to)
    when 'performance' then
      format('select count(*) from public.product_performance(%L, %L, null, %L)', p_from, p_to, p_business_id)
  end;
  if v_sql is null then
    raise exception 'perf_explain: unknown question %', p_which;
  end if;

  for r in execute 'explain (analyze, buffers, verbose false) ' || v_sql loop
    line := r."QUERY PLAN";
    return next;
  end loop;
end;
$$;

revoke all on function public.perf_explain(text, uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.perf_explain(text, uuid, timestamptz, timestamptz) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'perf_explain'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: perf_explain must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0080 verified: perf_explain is a read-only, invoker-rights measuring tool, closed to anon.';
end;
$$;

commit;
