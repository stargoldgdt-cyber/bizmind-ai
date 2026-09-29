-- ============================================================================
-- 0060  Dashboard: the profit bridge (why contribution changed)
-- ============================================================================
-- The executive dashboard redesign (owner request, 2026-09-29) wants a
-- period-over-period bridge -- "previous contribution -> what each cost and
-- revenue line did -> current contribution" -- next to the existing
-- percentage-only "What changed" list. Only percentage deltas existed before
-- this (dashboard_overview's *_change_pct columns); nothing exposed the
-- absolute dollar amount each line moved by.
--
-- dashboard_profit_bridge() mirrors dashboard_overview()'s own shape exactly
-- (same previous-period alignment rule -- a whole month compares with the
-- month before it, a quarter with the quarter before -- copied verbatim so
-- the two never disagree) and reuses pnl_summary() the same way
-- dashboard_overview() already does. The steps are Contribution's own
-- components (net sales, other income, marketplace fees, fulfilment,
-- advertising, other costs, non-recoverable VAT) -- the SAME identity
-- dashboard_waterfall_steps() already proves reconciles exactly, so the
-- bridge's steps sum to the ending value exactly, with no rounding fudge
-- bucket needed.
--
-- Bars are pre-scaled to a 0-1000 domain exactly like dashboard_waterfall_
-- steps() does, so the new chart component does no arithmetic of its own.
--
-- Additive only. Nothing existing is touched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create function public.dashboard_profit_bridge(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  step     integer,
  label    text,
  kind     text,
  amount   text,
  status   text,
  bar_from integer,
  bar_to   integer,
  zero_at  integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_months    integer;
  v_cur       record;
  v_prev      record;
  v_has       boolean;
  v_prev_has  boolean;
begin
  -- Copied verbatim from dashboard_overview() (0050) so the two never disagree
  -- about what "the period before" means.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and date_trunc('month', p_to at time zone 'UTC') = (p_to at time zone 'UTC')
     and p_to > p_from then
    v_months := (extract(year from p_to at time zone 'UTC')::integer * 12 + extract(month from p_to at time zone 'UTC')::integer)
              - (extract(year from p_from at time zone 'UTC')::integer * 12 + extract(month from p_from at time zone 'UTC')::integer);
    v_prev_from := (((p_from at time zone 'UTC') - make_interval(months => v_months)) at time zone 'UTC');
  end if;

  select s.* into v_cur
  from public.pnl_summary(p_from, p_to, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_has := found;

  select s.* into v_prev
  from public.pnl_summary(v_prev_from, p_from, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_prev_has := found;

  if not v_has or not v_prev_has then
    return;
  end if;

  return query
  with steps as (
    select v.step, v.label, v.kind, v.amount::numeric as amount, v.status
    from lateral (values
      (1, 'Previous contribution',     'START',
          v_prev.contribution_before_open_items,
          v_prev.contribution_status),
      (2, 'Net sales',                 'DELTA',
          (v_cur.net_sales::numeric - v_prev.net_sales::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (3, 'Other income',              'DELTA',
          (v_cur.other_income::numeric - v_prev.other_income::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (4, 'Marketplace fees',          'DELTA',
          (v_cur.marketplace_fees::numeric - v_prev.marketplace_fees::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (5, 'Fulfilment',                'DELTA',
          (v_cur.fulfillment::numeric - v_prev.fulfillment::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (6, 'Advertising',               'DELTA',
          (v_cur.advertising::numeric - v_prev.advertising::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (7, 'Other marketplace costs',   'DELTA',
          (v_cur.other_marketplace_costs::numeric - v_prev.other_marketplace_costs::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (8, 'Non-recoverable VAT',       'DELTA',
          (v_cur.non_recoverable_vat::numeric - v_prev.non_recoverable_vat::numeric)::text,
          case when v_cur.figures_status = 'FINAL' and v_prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
      (9, 'Current contribution',      'END',
          v_cur.contribution_before_open_items,
          v_cur.contribution_status)
    ) as v(step, label, kind, amount, status)
    where v.amount is not null
      -- Optional steps appear only when they carry something (mirrors
      -- dashboard_waterfall_steps' own skip-if-zero list).
      and not (v.step in (3, 7, 8) and v.amount::numeric = 0)
  ),
  running as (
    select
      s.*,
      case when s.kind in ('START', 'END') then 0::numeric
           else coalesce(max(s.amount) filter (where s.kind = 'START') over (), 0)
                + coalesce(sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and 1 preceding), 0)
      end as start_value,
      case when s.kind in ('START', 'END') then s.amount
           else coalesce(max(s.amount) filter (where s.kind = 'START') over (), 0)
                + sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and current row)
      end as end_value
    from steps s
  ),
  domain as (
    select least(0, min(least(r.start_value, r.end_value))) as lo,
           greatest(0, max(greatest(r.start_value, r.end_value))) as hi
    from running r
  )
  select
    r.step,
    r.label,
    r.kind,
    r.amount::numeric(20,4)::text,
    r.status,
    case when d.hi = d.lo then 0 else round((least(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
    case when d.hi = d.lo then 0 else round((greatest(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
    case when d.hi = d.lo then 0 else round((0 - d.lo) / (d.hi - d.lo) * 1000)::integer end
  from running r cross join domain d
  order by r.step;
end;
$$;

do $$
begin
  revoke all on function public.dashboard_profit_bridge(uuid, text, timestamptz, timestamptz, uuid) from anon, public;
  grant execute on function public.dashboard_profit_bridge(uuid, text, timestamptz, timestamptz, uuid) to authenticated;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dashboard_profit_bridge'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: dashboard_profit_bridge must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0060 verified: dashboard_profit_bridge() exists, SECURITY INVOKER, closed to anon.';
end;
$$;

commit;
