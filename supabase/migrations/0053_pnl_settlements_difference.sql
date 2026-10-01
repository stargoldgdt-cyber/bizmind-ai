-- ============================================================================
-- 0053  Settlements: a Difference column for the Reconciliation tab
-- ============================================================================
-- The Marketplace P&L refinement (owner request, 2026-09-26) adds a
-- Reconciliation tab that compares the marketplace's reported settlement
-- total against BizMind's own calculated total. The gap between them must be
-- shown as a figure, and money arithmetic only ever happens in SQL -- never
-- in TypeScript (money-guard) -- so pnl_settlements() gains ONE trailing
-- column:
--
--   difference   reported_total - lines_total (the same two figures the
--                table already returns, and the same subtraction already
--                used to compute "reconciles"). NULL exactly when
--                reported_total is NULL (no total reported), matching
--                "reconciles" is also meaningless with no total.
--
-- Every existing column and the reconciliation rule itself ("reconciles" =
-- reported_total equals the sum of lines) is copied verbatim from 0033.
-- Same signature (timestamptz, timestamptz, uuid). Bank Received is NOT
-- added here: no bank source is connected (owner decision, GCC Phase 8), and
-- the screen shows "Not connected" as a fixed label, not an invented figure.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

drop function public.pnl_settlements(timestamptz, timestamptz, uuid);

create function public.pnl_settlements(
  p_from       timestamptz,
  p_to         timestamptz,
  p_account_id uuid
)
returns table (
  settlement_id          uuid,
  source_file_id         uuid,
  file_name              text,
  external_settlement_id text,
  period_start           timestamptz,
  period_end             timestamptz,
  currency               char(3),
  reported_total         text,
  lines_total             text,
  lines_in_period        text,
  lines_in_period_count  bigint,
  reconciles             boolean,
  payout_amount          text,
  payout_date            timestamptz,
  -- 0053: for the Reconciliation tab.
  difference             text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    st.id,
    st.source_file_id,
    b.file_name,
    st.external_settlement_id,
    st.period_start,
    st.period_end,
    st.currency::char(3),
    st.reported_total::text,
    coalesce(sum(ft.amount), 0)::numeric(20,4)::text,
    coalesce(sum(ft.amount) filter (where ft.posted_at >= p_from and ft.posted_at < p_to), 0)::numeric(20,4)::text,
    count(ft.id) filter (where ft.posted_at >= p_from and ft.posted_at < p_to),
    st.reported_total is not null and st.reported_total = coalesce(sum(ft.amount), 0),
    (select po.amount::text from public.payouts po
      where po.settlement_id = st.id and po.voided_at is null
      order by po.created_at limit 1),
    (select po.paid_at from public.payouts po
      where po.settlement_id = st.id and po.voided_at is null
      order by po.created_at limit 1),
    case when st.reported_total is not null
      then (st.reported_total - coalesce(sum(ft.amount), 0))::numeric(20,4)::text
    end
  from public.settlements st
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  left join public.financial_transactions ft on ft.settlement_id = st.id
  where st.marketplace_account_id = p_account_id
  group by st.id, st.source_file_id, b.file_name, st.external_settlement_id,
           st.period_start, st.period_end, st.currency, st.reported_total
  having count(ft.id) filter (where ft.posted_at >= p_from and ft.posted_at < p_to) > 0
      or (st.period_start < p_to and coalesce(st.period_end, st.period_start) >= p_from)
  order by st.period_start nulls last, st.external_settlement_id;
$$;

-- Re-close the function: DROP + CREATE resets Postgres's default grant
-- (EXECUTE to PUBLIC), which the self-check below would otherwise catch and
-- abort on. This restores the exact grant 0033 set: authenticated only.
revoke all on function public.pnl_settlements(timestamptz, timestamptz, uuid) from anon, public;
grant execute on function public.pnl_settlements(timestamptz, timestamptz, uuid) to authenticated;

comment on function public.pnl_settlements(timestamptz, timestamptz, uuid) is
  'Settlements touching [p_from, p_to) for one account, with the reported total, the '
  'sum of its lines, the part attributed to this period, and their difference. difference '
  'added 0053; Bank Received is never computed here (no bank source is connected).';

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pnl_settlements'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: pnl_settlements must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0053 verified: pnl_settlements gains Difference.';
end;
$$;

commit;
