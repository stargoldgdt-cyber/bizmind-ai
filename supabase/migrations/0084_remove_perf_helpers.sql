-- ============================================================================
-- 0084  Remove every temporary measuring helper
-- ============================================================================
-- Owner approved, 2026-10-07: after the page optimisations are verified, clean up. All of
-- these were read-only and none is used by the app: perf_lab (0072), pnl_summary_next +
-- perf_compare_pnl (0074), pnl_summary_v3 + perf_compare_pnl3 (0075), perf_explain
-- (0077/79/80/81), ledger_lines_resolved + ledger_product_lines_in + perf_compare_lines
-- (0078/79/81), dashboard_accounts_next + perf_compare_accounts (0082). The approaches they
-- tested that did not pay off (classifying line types once: identical but about 2x slower)
-- are recorded in DECISIONS.md, not left as live code. Nothing the app uses is touched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

drop function if exists public.ledger_product_lines_in(uuid, timestamptz, timestamptz);
drop function if exists public.ledger_lines_resolved(uuid, timestamptz, timestamptz);
drop function if exists public.perf_compare_lines(uuid, timestamptz, timestamptz);
drop function if exists public.perf_compare_accounts(uuid, text, timestamptz, timestamptz);
drop function if exists public.dashboard_accounts_next(uuid, text, timestamptz, timestamptz);
drop function if exists public.perf_compare_pnl3(uuid, timestamptz, timestamptz, boolean);
drop function if exists public.pnl_summary_v3(timestamptz, timestamptz, uuid, uuid, boolean);
drop function if exists public.perf_compare_pnl(uuid, timestamptz, timestamptz, boolean);
drop function if exists public.pnl_summary_next(timestamptz, timestamptz, uuid, uuid, boolean);
drop function if exists public.perf_explain(text, uuid, timestamptz, timestamptz);
drop function if exists public.perf_lab(uuid, timestamptz, timestamptz);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('perf_lab', 'pnl_summary_next', 'perf_compare_pnl', 'pnl_summary_v3', 'perf_compare_pnl3',
                        'perf_explain', 'ledger_lines_resolved', 'ledger_product_lines_in', 'perf_compare_lines',
                        'dashboard_accounts_next', 'perf_compare_accounts')
  ) then
    raise exception 'CLEANUP: a temporary helper is still present.';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('pnl_summary', 'dashboard_accounts', 'product_performance', 'pnl_by_product')) < 4 then
    raise exception 'CLEANUP: the real functions must still exist.';
  end if;
  raise notice 'Migration 0084 verified: every temporary helper is gone; the real functions are untouched.';
end;
$$;

commit;
