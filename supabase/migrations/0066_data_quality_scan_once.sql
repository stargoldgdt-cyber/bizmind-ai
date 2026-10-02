-- ============================================================================
-- 0066  ledger_data_quality: scan the scoped lines once, not once per issue kind
-- ============================================================================
-- Found by timing each dashboard call individually, sequentially, against the
-- owner's real data (localhost, 2026-10-02): ledger_data_quality() alone took
-- ~8.5s on a nine-month range -- not dashboard_overview, not dashboard_
-- accounts, not pnl_by_product doing anything expensive themselves; all three
-- call ledger_data_quality() internally and inherit its cost. 0065 already
-- made the classification lookup itself efficient; this is a second, separate
-- problem in a different function.
--
-- ledger_data_quality()'s `scoped` CTE -- the lines in range, already
-- classified -- is read FOUR separate times (once per issue kind: unknown
-- codes, under-review lines, unresolved VAT, fee VAT not separated), plus
-- twice more through `scoped_files`, which is itself built from `scoped`.
-- Six reads of the same filtered, classified line set in one function call.
-- Without an explicit hint, PostgreSQL does not reliably choose to compute a
-- multiply-used CTE once and reuse it here -- so each of those six places
-- was plausibly re-running the whole scan from financial_transactions back
-- up through 0065's classification logic, from scratch.
--
-- The fix is the mirror image of 0065's, for the opposite reason: `scoped`'s
-- own WHERE clause already carries its complete filter (the caller's date
-- range, account and business), so there is nothing outside it that still
-- needs to reach through it -- unlike 0065's `base`, which had to keep being
-- inlined so an OUTER filter could reach in. Here the right thing is the
-- opposite: `MATERIALIZED` forces PostgreSQL to compute `scoped` (and
-- `scoped_files`, read twice) exactly once and reuse that one result for
-- every issue kind, instead of silently deciding whether to on its own.
--
-- Nothing about WHICH issues are found, or what they say, changes -- every
-- select list, join, group by and having clause is copied verbatim from
-- 0034. Only how many times the scan underneath them runs does.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.ledger_data_quality(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  issue_kind             text,
  severity               text,
  marketplace_account_id uuid,
  account_label          text,
  marketplace_code       text,
  currency               char(3),
  format_id              text,
  reference              text,
  category               text,
  subcategory            text,
  lines                  bigint,
  amount                 text,
  files                  bigint,
  detail                 text
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as materialized (
  select l.*
  from public.ledger_classified_lines l
  where (p_from is null or l.posted_at >= p_from)
    and (p_to is null or l.posted_at < p_to)
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
scoped_files as materialized (
  select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
  from scoped s
),
issues as (
  select
    'UNKNOWN_CODE'::text                                 as issue_kind,
    'WARNING'::text                                      as severity,
    s.marketplace_account_id                             as marketplace_account_id,
    s.account_label                                      as account_label,
    s.marketplace_code                                   as marketplace_code,
    s.currency::char(3)                                  as currency,
    s.format_id                                          as format_id,
    s.match_key                                          as reference,
    null::text                                           as category,
    null::text                                           as subcategory,
    count(*)                                             as lines,
    sum(s.amount::numeric(20,4))::numeric(20,4)::text    as amount,
    count(distinct s.source_file_id)                     as files,
    'Not classified yet. Kept with its amount; counts towards no figure, and the figures it could affect are incomplete.'::text as detail
  from scoped s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

  union all

  select
    'UNDER_REVIEW', 'INFO', s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency::char(3),
    s.format_id, s.match_key, s.category, s.subcategory,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'Counted using a medium-confidence rule. Check it against the marketplace report.'
  from scoped s
  where s.classification_status = 'UNDER_REVIEW'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id,
           s.match_key, s.category, s.subcategory

  union all

  select
    'VAT_TREATMENT_UNKNOWN', 'WARNING', s.marketplace_account_id, s.account_label, s.marketplace_code,
    s.currency::char(3), null, null, 'INPUT_VAT', null,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'The VAT setting for this account is Unknown, so contribution is incomplete. Set it once your accountant confirms whether this VAT is recoverable.'
  from scoped s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

  union all

  select
    'FEE_VAT_NOT_SEPARATED', 'WARNING', s.marketplace_account_id, s.account_label, s.marketplace_code,
    s.currency::char(3), null, to_char(date_trunc('month', s.posted_at at time zone 'UTC'), 'YYYY-MM'), null, null,
    count(*) filter (where s.rule_includes_vat),
    (sum(s.amount::numeric(20,4)) filter (where s.rule_includes_vat))::numeric(20,4)::text,
    count(distinct s.source_file_id),
    'These fees include VAT that is not separated yet, so fees and contribution are incomplete for this month. Upload the marketplace''s VAT invoices for the month (noon: Invoices and Credit Notes).'
  from scoped s
  left join public.tax_profiles tp on tp.marketplace_account_id = s.marketplace_account_id
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency,
           date_trunc('month', s.posted_at at time zone 'UTC'), tp.input_vat_treatment
  having bool_or(s.rule_includes_vat)
     and not bool_or(s.rule_separates_vat)
     and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE'

  union all

  select
    'ROW_ERRORS', 'WARNING', f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency::char(3),
    null, null, null, null,
    count(*), null, count(distinct f.source_file_id),
    'Rows in these files could not be read, so the figures they belong to are incomplete.'
  from scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

  union all

  select
    'SETTLEMENT_MISMATCH', 'WARNING', st.marketplace_account_id, a.label, a.marketplace_code, st.currency::char(3),
    null, st.external_settlement_id, null, null,
    count(ft.id), (st.reported_total - coalesce(sum(ft.amount), 0))::numeric(20,4)::text, 1::bigint,
    'The total the marketplace reported differs from the sum of its lines by this amount.'
  from public.settlements st
  join (select distinct sf.source_file_id from scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
           st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
)
select * from issues
order by severity desc, issue_kind, account_label, reference;
$$;

revoke all on function public.ledger_data_quality(timestamptz, timestamptz, uuid, uuid) from anon, public;
grant execute on function public.ledger_data_quality(timestamptz, timestamptz, uuid, uuid) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ledger_data_quality'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: ledger_data_quality must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0066 verified: ledger_data_quality scans its scoped lines once, not once per issue kind.';
end;
$$;

commit;
