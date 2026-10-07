-- ============================================================================
-- 0077  perf_explain(): TEMPORARY read-only measuring tool (dropped in the cleanup)
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- After 0076 the P&L is about 30% faster, but a month still takes 0.5-1 s and eight
-- months 5-8 s. Before changing anything else I want to know WHERE that time goes:
-- reading the rows from disk (the Free plan's disk is slow), or working on them. Postgres
-- can say so, with EXPLAIN (ANALYZE, BUFFERS): how many 8 kB pages were found in memory
-- and how many had to be read from disk, and how long each step took.
--
-- perf_explain() runs that for four FIXED questions only (nothing the caller types is
-- ever run as SQL; only the dates and the business id are inserted, quoted):
--   raw       the stored lines in the period, counted
--   classified  the same through ledger_classified_lines (rule matching)
--   product   the same through ledger_product_lines (product, cost, refund credit)
--   performance  product_performance() itself
-- It reads, never writes; SECURITY INVOKER (row level security applies as for any
-- user); closed to anon.
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
  raise notice 'Migration 0077 verified: perf_explain is a read-only, invoker-rights measuring tool, closed to anon.';
end;
$$;

commit;
