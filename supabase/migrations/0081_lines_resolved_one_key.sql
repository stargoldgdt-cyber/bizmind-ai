-- ============================================================================
-- 0081  ledger_lines_resolved(): the join the planner could not get wrong
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- The real plan (0080) showed why 0078/0079 were slow. The few dozen classified line types
-- were joined back to the lines on four separate columns, one of them the business id,
-- which the planner replaced by a constant and then guessed "1 row" for the whole
-- per-type step. It chose a nested loop that re-read the file's lines once per (file, type)
-- pair: 1,240 re-reads for a 994-line month; run as a function with unknown parameters it
-- was worse still (162,000 memory pages).
--
-- Each line and each type now carries ONE text key (business, account, format, line type; the
-- format is length-prefixed so the key is unambiguous and a missing format stays distinct).
-- The join is a single plain equality, so nothing can be propagated into the small step and
-- Postgres hashes the few dozen types. The rows, columns and values are exactly those of
-- 0078/0079; perf_compare_lines() still compares every column of every line to the view.
--
-- perf_explain() (0077/0079/0080) gets the new body for its 'resolved_body' question.
-- Read-only, SECURITY INVOKER, closed to anon. Nothing else is touched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

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
with scoped0 as not materialized (
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
scoped as not materialized (
  select s.*,
    s.business_id::text || '/' || s.marketplace_account_id::text || '/' || case when s.format_id is null then '-' else length(s.format_id)::text || ':' || s.format_id end || '/' || s.match_key as type_key
  from scoped0 s
),
types as materialized (
  -- The few distinct line types present in the period.
  select distinct s.business_id, s.marketplace_account_id, s.marketplace_code, s.format_id, s.match_key
  from scoped0 s
),
resolved as materialized (
  -- Each type is classified ONCE: the identical rule look-up and treatment as the view.
  select
    t.business_id::text || '/' || t.marketplace_account_id::text || '/' || case when t.format_id is null then '-' else length(t.format_id)::text || ':' || t.format_id end || '/' || t.match_key as type_key,
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
join resolved r on r.type_key = s.type_key;
$$;

revoke all on function public.ledger_lines_resolved(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.ledger_lines_resolved(uuid, timestamptz, timestamptz) to authenticated;

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
with scoped0 as not materialized (
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
scoped as not materialized (
  select s.*,
    s.business_id::text || '/' || s.marketplace_account_id::text || '/' || case when s.format_id is null then '-' else length(s.format_id)::text || ':' || s.format_id end || '/' || s.match_key as type_key
  from scoped0 s
),
types as materialized (
  -- The few distinct line types present in the period.
  select distinct s.business_id, s.marketplace_account_id, s.marketplace_code, s.format_id, s.match_key
  from scoped0 s
),
resolved as materialized (
  -- Each type is classified ONCE: the identical rule look-up and treatment as the view.
  select
    t.business_id::text || '/' || t.marketplace_account_id::text || '/' || case when t.format_id is null then '-' else length(t.format_id)::text || ':' || t.format_id end || '/' || t.match_key as type_key,
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
join resolved r on r.type_key = s.type_key
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
    where n.nspname = 'public'
      and p.proname in ('ledger_lines_resolved', 'perf_explain')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the functions must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0081 verified: ledger_lines_resolved joins types by one key; read-only, invoker-rights, closed to anon.';
end;
$$;

commit;
