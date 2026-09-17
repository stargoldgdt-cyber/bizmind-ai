-- ============================================================================
-- 0039  Expected marketplace payouts, their checks, and expected cashflow
-- ============================================================================
-- GCC Phase 8, part 1. Readers only: nothing is written, no table is added.
--
-- THE OWNER'S DECISION (2026-09-17)
--   There is no bank statement for this workflow. The marketplace's own report
--   is the source of the EXPECTED payout:
--     Amazon  a settlement's reported total is its expected payout
--     noon    a "Payment Disbursal" row is a payout noon reports sending
--   An expected payout is NEVER money received. "Actual bank receipt" is a
--   separate concept and stays NOT_CONNECTED until a real bank source is
--   connected in a later phase. No bank transaction is created or assumed.
--
-- WHAT IS ADDED
--   expected_payouts()   one row per expected payout, with the marketplace-side
--                        check (does the settlement add up to its lines?) and a
--                        bank side that is always NOT_CONNECTED for now.
--   expected_cashflow()  expected marketplace inflow per month and currency,
--                        beside a bank column that is NOT_CONNECTED.
--
-- Reconciliation statuses (marketplace side):
--   ADDS_UP                the settlement total equals the sum of its lines
--   DOES_NOT_ADD_UP        it does not: the expected payout is in doubt
--   NO_TOTAL               the settlement states no total: no expected amount
--   MARKETPLACE_PAYMENT    a payout the marketplace reports sending (noon),
--                          not tied to a settlement total
-- Bank side, every row: NOT_CONNECTED. Decision B9 (tolerance and date
-- window) applies only once a bank source exists; its default is unchanged.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0038.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

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
  bank_receipt_date      timestamptz
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
  null::timestamptz
from together t
join public.marketplace_accounts a on a.id = t.marketplace_account_id
where (p_from is null or coalesce(t.expected_date, t.period_end, t.period_start) >= p_from)
  and (p_to is null or coalesce(t.expected_date, t.period_end, t.period_start) < p_to)
order by coalesce(t.expected_date, t.period_end, t.period_start) nulls last, a.label, t.reference;
$$;

comment on function public.expected_payouts(uuid, timestamptz, timestamptz, uuid) is
  'What the marketplaces report they will pay, from their own reports. Expected, '
  'never received: bank_receipt_status is NOT_CONNECTED until a bank source exists.';

create function public.expected_cashflow(
  p_business_id uuid,
  p_from        timestamptz default null,
  p_to          timestamptz default null
)
returns table (
  month                     date,
  currency                  text,
  expected_payouts          bigint,
  expected_inflow           text,
  payouts_in_doubt          bigint,
  amount_in_doubt           text,
  payouts_without_amount    bigint,
  bank_receipt_status       text,
  bank_received             text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    date_trunc('month', e.expected_date at time zone 'UTC')::date,
    e.currency,
    count(*),
    coalesce(sum(e.expected_amount::numeric), 0)::numeric(20,4)::text,
    count(*) filter (where e.marketplace_status = 'DOES_NOT_ADD_UP'),
    coalesce(sum(e.expected_amount::numeric) filter (where e.marketplace_status = 'DOES_NOT_ADD_UP'), 0)::numeric(20,4)::text,
    count(*) filter (where e.expected_amount is null),
    'NOT_CONNECTED'::text,
    null::text
  from public.expected_payouts(p_business_id, p_from, p_to, null) e
  where e.expected_date is not null
  group by 1, 2
  order by 1, 2;
$$;

comment on function public.expected_cashflow(uuid, timestamptz, timestamptz) is
  'Expected marketplace inflow per month (by expected payout date) and currency. '
  'Planning only: bank_received stays NULL and NOT_CONNECTED until a bank source exists.';

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.expected_payouts(uuid, timestamptz, timestamptz, uuid)',
    'public.expected_cashflow(uuid, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['expected_payouts', 'expected_cashflow']
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = f) <> 1 then
      raise exception 'Exactly one %() must exist.', f;
    end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (position('insert into' in lower(p.prosrc)) > 0 or position('bank_transactions' in p.prosrc) > 0)
    ) then
      raise exception 'SELF-CHECK: %() must only read, and must not read any bank data.', f;
    end if;
  end loop;

  raise notice 'Migration 0039 verified: expected payouts and cashflow are read-only invoker readers; bank side NOT_CONNECTED.';
end;
$$;

commit;
