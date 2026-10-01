-- ============================================================================
-- 0056  expected_payouts(): a Difference column, for the Marketplace P&L's
--       Settlements/Reconciliation tabs to use instead of pnl_settlements()
-- ============================================================================
-- Owner request (2026-09-26): the Settlements and Reconciliation tabs on
-- Marketplace P&L, built today from pnl_settlements(), only ever show
-- something for a marketplace that files formal SETTLEMENT reports (Amazon).
-- noon reports payments directly, with no settlement total to check against
-- (decision, migration 0039) -- so for noon, those tabs always said "No
-- settlement report covers this month," even on a month with a real,
-- reportable payout. Two marketplaces, two different experiences.
--
-- expected_payouts() (migration 0039) already reads BOTH kinds through one
-- shape (marketplace_status: ADDS_UP / DOES_NOT_ADD_UP / NO_TOTAL /
-- MARKETPLACE_PAYMENT) -- it already powers Payouts and cashflow. This adds
-- the one thing it was missing for the P&L tabs to use it too: a Difference
-- column, the same reported-minus-calculated figure pnl_settlements() already
-- exposes (migration 0053), so Reconciliation can show it without any new
-- arithmetic anywhere. NULL for a noon-style payment (there is nothing to
-- calculate against -- only what noon itself reported), same as before.
--
-- pnl_settlements() and the export it feeds (services/ledger/export.ts) are
-- UNCHANGED and continue to work exactly as they do today -- this is a new,
-- additive column only.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

drop function public.expected_payouts(uuid, timestamptz, timestamptz, uuid);

create function public.expected_payouts(
  p_business_id uuid,
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_account_id  uuid default null
)
returns table (
  payout_key             uuid,
  source                 text,
  marketplace_account_id uuid,
  account_label          text,
  marketplace_code       text,
  currency               text,
  reference              text,
  source_file_id         uuid,
  file_name              text,
  period_start           timestamptz,
  period_end             timestamptz,
  expected_date          timestamptz,
  expected_amount        text,
  settlement_lines_total text,
  settlement_lines       bigint,
  marketplace_status     text,
  bank_receipt_status    text,
  bank_receipt_amount    text,
  bank_receipt_date      timestamptz,
  -- 0056: reported minus calculated, for the P&L's Reconciliation tab. NULL
  -- for a noon-style payment: there is no separate calculated figure to
  -- compare against a stated total, only the one amount noon itself reported.
  difference              text
)
language sql
stable
security invoker
set search_path = ''
as $$
with from_settlements as (
  select
    st.id                                                    as payout_key,
    'SETTLEMENT_REPORT'::text                                as source,
    st.marketplace_account_id,
    st.external_settlement_id                                as reference,
    st.source_file_id,
    b.file_name,
    st.period_start,
    st.period_end,
    coalesce(st.reported_deposit_date,
      (select po.paid_at from public.payouts po
        where po.settlement_id = st.id and po.voided_at is null
        order by po.created_at limit 1))                     as expected_date,
    st.reported_total                                        as expected_amount,
    coalesce(sum(ft.amount), 0)::numeric(20,4)               as lines_total,
    count(ft.id)                                             as lines,
    case
      when st.reported_total is null then 'NO_TOTAL'
      when st.reported_total = coalesce(sum(ft.amount), 0) then 'ADDS_UP'
      else 'DOES_NOT_ADD_UP'
    end                                                      as marketplace_status
  from public.settlements st
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  left join public.financial_transactions ft on ft.settlement_id = st.id
  where st.business_id = p_business_id
    and (p_account_id is null or st.marketplace_account_id = p_account_id)
  group by st.id, b.file_name
),
from_payments as (
  select
    po.id                                                    as payout_key,
    'MARKETPLACE_PAYMENT_REPORT'::text                       as source,
    po.marketplace_account_id,
    po.external_ref                                          as reference,
    po.source_file_id,
    b.file_name,
    null::timestamptz                                        as period_start,
    null::timestamptz                                        as period_end,
    po.paid_at                                               as expected_date,
    po.amount                                                as expected_amount,
    null::numeric(20,4)                                      as lines_total,
    null::bigint                                             as lines,
    'MARKETPLACE_PAYMENT'::text                              as marketplace_status
  from public.payouts po
  join public.import_batches b on b.id = po.source_file_id and b.withdrawn_at is null
  where po.business_id = p_business_id
    and po.settlement_id is null
    and po.voided_at is null
    and po.origin = 'SOURCE_FILE'
    and (p_account_id is null or po.marketplace_account_id = p_account_id)
),
together as (
  select * from from_settlements
  union all
  select * from from_payments
)
select
  t.payout_key,
  t.source,
  t.marketplace_account_id,
  a.label,
  a.marketplace_code,
  a.currency::text,
  t.reference,
  t.source_file_id,
  t.file_name,
  t.period_start,
  t.period_end,
  t.expected_date,
  t.expected_amount::numeric(20,4)::text,
  t.lines_total::text,
  t.lines,
  t.marketplace_status,
  -- No bank source exists yet. Never inferred from the marketplace's report.
  'NOT_CONNECTED'::text,
  null::text,
  null::timestamptz,
  -- 0056: numeric(20,4) arithmetic with a NULL lines_total (a noon payment)
  -- yields NULL automatically -- no CASE needed, same rule SQL always uses.
  (t.expected_amount::numeric(20,4) - t.lines_total)::numeric(20,4)::text
from together t
join public.marketplace_accounts a on a.id = t.marketplace_account_id
where (p_from is null or coalesce(t.expected_date, t.period_end, t.period_start) >= p_from)
  and (p_to is null or coalesce(t.expected_date, t.period_end, t.period_start) < p_to)
order by coalesce(t.expected_date, t.period_end, t.period_start) nulls last, a.label, t.reference;
$$;

-- Re-close the function: DROP + CREATE resets Postgres's default grant
-- (EXECUTE to PUBLIC). Restores the exact grant 0039 set: authenticated only.
revoke all on function public.expected_payouts(uuid, timestamptz, timestamptz, uuid) from anon, public;
grant execute on function public.expected_payouts(uuid, timestamptz, timestamptz, uuid) to authenticated;

comment on function public.expected_payouts(uuid, timestamptz, timestamptz, uuid) is
  'What the marketplaces report they will pay, from their own reports. Expected, '
  'never received: bank_receipt_status is NOT_CONNECTED until a bank source exists. '
  'difference (0056) is reported minus calculated; NULL for a noon-style payment.';

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'expected_payouts'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: expected_payouts must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0056 verified: expected_payouts gains Difference, for one Settlements/Reconciliation view across every marketplace.';
end;
$$;

commit;
