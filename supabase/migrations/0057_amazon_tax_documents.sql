-- ============================================================================
-- 0057  Amazon VAT tax invoices and credit notes (PDF), connector-ready
-- ============================================================================
-- The owner asked why the Marketplace P&L's recoverable VAT was unusually low
-- (AED 116.44) given Amazon deducts 5% VAT. Tracing four real August 2026
-- documents (two tax invoices, two credit notes, Souq.com FZ LLC) against the
-- account's own settlement showed why: Amazon's settlement report only
-- itemises VAT for ONE fee (the SP 360 / "Paid Services Fee" line, migration
-- 0044). Every other fee -- referral commission, chargebacks, closing fees,
-- the per-unit fee -- carries 5% VAT that Amazon charges but never puts in
-- the settlement; it only appears on a separate monthly tax invoice (PDF
-- only -- Seller Central offers no CSV/Excel export of these documents,
-- confirmed with the owner). The true total for August was AED 293.95, not
-- AED 116.44.
--
-- Owner decision (2026-09-28): keep this upload OPTIONAL, and build it
-- connector-ready -- the same normalised ingestion layer, transaction types,
-- identifiers, reconciliation logic and VAT rules a future Amazon SP-API
-- connector (or a future noon/Carrefour connector) will use, not a
-- manual-only path to be replaced later. See DECISIONS.md.
--
-- WHAT CHANGES
--   1. `financial_transactions` gains `external_ref` -- the document number a
--      line came from (an invoice or credit note number today), so every VAT
--      entry these documents add is traceable back to its source document.
--      Marketplace-agnostic: any future connector can carry its own document
--      id through the same column. Not `order_ref` (an order id means a
--      different fact).
--   2. `ledger_apply_file()` accepts `pdf` as a file type, validates and
--      writes `external_ref`. Everything else in the function is unchanged,
--      copied verbatim (a diff against 0034's version shows only these three
--      edits).
--   3. `ledger_classified_lines` exposes `external_ref` (appended; existing
--      readers of the view are unaffected).
--   4. Two new formats on the existing Amazon adapter, both optional:
--      `amazon.tax_invoice` and `amazon.tax_credit_note`. Every fee amount
--      these documents state is Amazon's OWN restatement of a fee ALREADY
--      recorded through the settlement (its "Price (Excl. Tax)" column
--      reconciles to the settlement's own fee lines) -- recording it again
--      would double the fee, not just add VAT. So only the VAT column ever
--      becomes a new P&L-affecting transaction (side TAX, category FEE_VAT
--      at import; category INPUT_VAT at classification, exactly like the
--      existing SP 360 VAT rule). The fee-excl-tax column, and "Paid
--      Services Fee"'s VAT (which the settlement already reports combined
--      with its fee, migration 0044), are recorded but classified
--      INFORMATIONAL -- kept for traceability, never counted, using the
--      category that already exists for exactly this (migration 0032).
--
-- Nothing about the settlement format, its rules, or any existing ledger row
-- changes. This upload is entirely additive and optional; a business that
-- never uploads these documents sees no change. Depends on 0030, 0032, 0034,
-- 0035, 0044.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. external_ref: the document number a line came from
-- ----------------------------------------------------------------------------

alter table public.financial_transactions
  add column external_ref text check (external_ref is null or length(external_ref) <= 200);

comment on column public.financial_transactions.external_ref is
  'The document number this line came from, as the marketplace itself names '
  'it (an invoice or credit note number). Not an order id -- see order_ref.';

alter table public.financial_transactions
  drop constraint financial_transactions_no_email_check;

alter table public.financial_transactions
  add constraint financial_transactions_no_email_check check (
    not public.ledger_text_has_email(
      concat_ws(' ', source_type, source_subtype, source_description,
                order_ref, order_line_ref, raw_sku, subcategory, external_ref))
  );

-- ----------------------------------------------------------------------------
-- 2. ledger_apply_file(): accept pdf, validate and write external_ref
-- ----------------------------------------------------------------------------
-- Copied verbatim from migration 0034 except for three edits: the file_type
-- allow-list, the external_ref length/email check, and external_ref in the
-- transaction insert. create or replace keeps the function's existing grants.

create or replace function public.ledger_apply_file(p_file jsonb)
returns table (
  source_file_id       uuid,
  duplicate            boolean,
  rows_written         integer,
  transactions_written integer,
  settlements_written  integer,
  payouts_written      integer,
  issues_written       integer,
  unmapped_written     integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_account_id  uuid;
  v_business_id uuid;
  v_account     public.marketplace_accounts;
  v_existing    uuid;
  v_file_id     uuid;
  v_format      text;
  v_version     text;
  v_sha         text;
  v_file_name   text;
  v_file_type   text;
  v_size        bigint;
  v_source_kind text;
  v_stripped    text[];
  v_problem     text;
  v_key         text;
  v_payout      record;
  v_payout_id   uuid;
  v_rows        integer;
  v_failed      integer;
  v_tx          integer;
  v_st          integer;
  v_po          integer;
  v_is          integer;
  v_unmapped    integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if p_file is null or jsonb_typeof(p_file) <> 'object' then
    raise exception 'The ledger file is not readable.' using errcode = '22023';
  end if;

  -- ---- the account, tenant and role ----------------------------------------
  if coalesce(p_file ->> 'marketplace_account_id', '')
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_account_id := (p_file ->> 'marketplace_account_id')::uuid;
  end if;

  select a.business_id into v_business_id
  from public.marketplace_accounts a where a.id = v_account_id;

  if v_business_id is null
     or v_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That marketplace account could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_business_id, array['OWNER', 'ADMIN', 'STAFF']::public.business_role[]) then
    raise exception 'A viewer cannot import data.' using errcode = '42501';
  end if;

  -- Serialises applies (and restores) per account, so the duplicate and
  -- settlement checks below cannot race.
  select * into v_account from public.marketplace_accounts a where a.id = v_account_id for update;

  if v_account.status <> 'ACTIVE' then
    raise exception 'This marketplace account is archived, so nothing more can be imported into it.'
      using errcode = 'P0001';
  end if;

  -- ---- the file record -----------------------------------------------------
  v_format      := nullif(trim(coalesce(p_file ->> 'format_id', '')), '');
  v_version     := nullif(trim(coalesce(p_file ->> 'adapter_version', '')), '');
  v_sha         := p_file ->> 'file_sha256';
  v_file_name   := nullif(trim(coalesce(p_file ->> 'file_name', '')), '');
  v_file_type   := p_file ->> 'file_type';
  v_source_kind := coalesce(nullif(p_file ->> 'source_kind', ''), 'UPLOAD');

  if v_format is null or length(v_format) > 120 then
    raise exception 'format_id is required.' using errcode = '22023';
  end if;
  if v_version is null or length(v_version) > 40 then
    raise exception 'adapter_version is required.' using errcode = '22023';
  end if;
  if coalesce(v_sha, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'file_sha256 must be a lowercase SHA-256 hex digest.' using errcode = '22023';
  end if;
  if v_file_name is null or length(v_file_name) > 255 or public.ledger_text_has_email(v_file_name) then
    raise exception 'file_name is required, at most 255 characters, and may not contain an email address.'
      using errcode = '22023';
  end if;
  if coalesce(v_file_type, '') not in ('csv', 'xlsx', 'txt', 'pdf') then
    raise exception 'file_type must be csv, xlsx, txt or pdf.' using errcode = '22023';
  end if;
  if coalesce(p_file ->> 'file_size_bytes', '') !~ '^[0-9]{1,12}$' then
    raise exception 'file_size_bytes must be a whole number.' using errcode = '22023';
  end if;
  v_size := (p_file ->> 'file_size_bytes')::bigint;
  if v_source_kind not in ('UPLOAD', 'API') then
    raise exception 'source_kind must be UPLOAD or API.' using errcode = '22023';
  end if;

  foreach v_key in array array['columns', 'stripped_columns', 'settlements', 'payouts', 'transactions', 'issues']
  loop
    if p_file ? v_key and jsonb_typeof(p_file -> v_key) <> 'array' then
      raise exception '% must be an array.', v_key using errcode = '22023';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_file -> 'columns', '[]') || coalesce(p_file -> 'stripped_columns', '[]')) e
    where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 300
       or public.ledger_text_has_email(e #>> '{}')
  ) then
    raise exception 'columns and stripped_columns must be lists of column names.' using errcode = '22023';
  end if;

  v_stripped := array(select jsonb_array_elements_text(coalesce(p_file -> 'stripped_columns', '[]')));

  -- ---- the same file again is a no-op --------------------------------------
  select b.id into v_existing
  from public.import_batches b
  where b.dataset = 'LEDGER'
    and b.marketplace_account_id = v_account.id
    and b.file_sha256 = v_sha
    and b.withdrawn_at is null;

  if v_existing is not null then
    return query select v_existing, true, 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- ---- stage the payload ---------------------------------------------------
  if jsonb_typeof(p_file -> 'rows') is distinct from 'array'
     or jsonb_array_length(p_file -> 'rows') = 0 then
    raise exception 'A ledger file needs at least one source row.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_file -> 'rows') > 50000 then
    raise exception 'A ledger file may hold at most 50,000 rows. Split it and apply each part.'
      using errcode = '22023';
  end if;

  drop table if exists pg_temp.ledger_in_rows;
  drop table if exists pg_temp.ledger_rows;
  drop table if exists pg_temp.ledger_in_settlements;
  drop table if exists pg_temp.ledger_in_payouts;
  drop table if exists pg_temp.ledger_in_transactions;
  drop table if exists pg_temp.ledger_in_issues;
  drop table if exists pg_temp.ledger_payout_ids;

  create temporary table ledger_in_rows on commit drop as
    select e.ordinality::integer as position, e.value as v
    from jsonb_array_elements(p_file -> 'rows') with ordinality e;

  -- ---- source rows ---------------------------------------------------------
  select format('Source row %s is not readable: it needs a row_number and an object of raw values.', r.position)
  into v_problem
  from pg_temp.ledger_in_rows r
  where jsonb_typeof(r.v) <> 'object'
     or coalesce(r.v ->> 'row_number', '') !~ '^[1-9][0-9]{0,6}$'
     or jsonb_typeof(r.v -> 'raw') is distinct from 'object'
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row number %s appears more than once.', r.v ->> 'row_number')
  into v_problem
  from pg_temp.ledger_in_rows r
  group by r.v ->> 'row_number'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s contains the customer-data column "%s". Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where public.ledger_is_customer_column(e.key)
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", contains an email address. Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) = 'string' and public.ledger_text_has_email(e.value #>> '{}')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", is not text. Source values are stored exactly as read, as text or blank.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) not in ('string', 'null')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  create temporary table ledger_rows on commit drop as
    select (r.v ->> 'row_number')::integer as row_number, r.v -> 'raw' as raw
    from pg_temp.ledger_in_rows r;
  create unique index on pg_temp.ledger_rows (row_number);

  create temporary table ledger_in_settlements on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'settlements', '[]')) with ordinality e;

  create temporary table ledger_in_payouts on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'payouts', '[]')) with ordinality e;

  create temporary table ledger_in_transactions on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'transactions', '[]')) with ordinality e;
  create index on pg_temp.ledger_in_transactions (row_no);

  create temporary table ledger_in_issues on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'issues', '[]')) with ordinality e;

  -- ---- settlements ---------------------------------------------------------
  select format('Settlement %s: %s', s.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_settlements s
  cross join lateral (
    select case
      when jsonb_typeof(s.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(s.v -> 'external_settlement_id') is distinct from 'string'
           or length(s.v ->> 'external_settlement_id') not between 1 and 200
           or public.ledger_text_has_email(s.v ->> 'external_settlement_id')
        then 'external_settlement_id is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = s.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(s.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(s.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(s.v -> 'reported_total')
                or public.ledger_json_is_money(s.v -> 'reported_total'))
        then 'reported_total must be exact decimal text or blank'
      when not (public.ledger_json_is_absent(s.v -> 'period_start') or public.ledger_json_is_instant(s.v -> 'period_start'))
        or not (public.ledger_json_is_absent(s.v -> 'period_end') or public.ledger_json_is_instant(s.v -> 'period_end'))
        or not (public.ledger_json_is_absent(s.v -> 'reported_deposit_date') or public.ledger_json_is_instant(s.v -> 'reported_deposit_date'))
        then 'its dates must be timestamps with a time zone, or blank'
    end as problem
  ) x
  where x.problem is not null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Settlement %s appears more than once in this file.', s.v ->> 'external_settlement_id')
  into v_problem
  from pg_temp.ledger_in_settlements s
  group by s.v ->> 'external_settlement_id'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- Decision B8: the same settlement may count once. A different file carrying
  -- it is refused, with the file already counting it named.
  select format('Settlement %s is already counted from the file "%s". Withdraw that file first if this one replaces it.',
                s.v ->> 'external_settlement_id', b.file_name)
  into v_problem
  from pg_temp.ledger_in_settlements s
  join public.settlements st
    on st.marketplace_account_id = v_account.id
   and st.external_settlement_id = s.v ->> 'external_settlement_id'
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- ---- payouts -------------------------------------------------------------
  select format('Payout %s: %s', p.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_payouts p
  cross join lateral (
    select case
      when jsonb_typeof(p.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(p.v -> 'key') is distinct from 'string'
           or length(p.v ->> 'key') not between 1 and 80
        then 'key is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = p.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when public.ledger_json_is_absent(p.v -> 'amount')
        then 'its amount is blank. A payout without an amount is a row issue, not a payout'
      when not public.ledger_json_is_money(p.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(p.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(p.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(p.v -> 'paid_at') or public.ledger_json_is_instant(p.v -> 'paid_at'))
        then 'paid_at must be a timestamp with a time zone, or blank'
      when not public.ledger_json_is_optional_text(p.v -> 'external_ref', 200)
        then 'external_ref is too long or contains an email address'
      when coalesce(p.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = p.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
    end as problem
  ) x
  where x.problem is not null
  order by p.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Payout key %s appears more than once.', p.v ->> 'key')
  into v_problem
  from pg_temp.ledger_in_payouts p
  group by p.v ->> 'key'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- transactions --------------------------------------------------------
  select format('Transaction %s: %s', t.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_transactions t
  left join public.ledger_mapping_rules mr
    on mr.id = case
                 when coalesce(t.v ->> 'mapping_rule_id', '')
                      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (t.v ->> 'mapping_rule_id')::uuid
               end
  cross join lateral (
    select case
      when jsonb_typeof(t.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = t.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(t.v ->> 'line_index', '0') !~ '^[0-9]{1,4}$'
        then 'line_index must be a whole number'
      when coalesce(t.v ->> 'attribution', '') not in ('ORDER_LINE', 'ORDER', 'MARKETPLACE')
        then 'attribution must be ORDER_LINE, ORDER or MARKETPLACE'
      when public.ledger_json_is_absent(t.v -> 'amount')
        then 'its amount is blank. A blank amount is recorded as a row issue, never as a transaction'
      when not public.ledger_json_is_money(t.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(t.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(t.v ->> 'currency', '(blank)'), v_account.currency)
      when not public.ledger_json_is_instant(t.v -> 'posted_at')
        then 'posted_at must be a timestamp with a time zone'
      when not public.ledger_json_is_optional_text(t.v -> 'source_type', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_subtype', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_description', 500)
        or not public.ledger_json_is_optional_text(t.v -> 'order_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'order_line_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'raw_sku', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'subcategory', 80)
        or not public.ledger_json_is_optional_text(t.v -> 'external_ref', 200)
        then 'a text field is too long or contains an email address'
      when not (public.ledger_json_is_absent(t.v -> 'quantity') or public.ledger_json_is_money(t.v -> 'quantity'))
        then 'quantity must be exact decimal text, or blank'
      when public.ledger_json_is_absent(t.v -> 'quantity') <> (coalesce(t.v ->> 'quantity_basis', '') = '')
        then 'quantity and quantity_basis must be given together'
      when coalesce(t.v ->> 'quantity_basis', '') not in ('', 'REPORTED', 'DERIVED_LINE_COUNT')
        then 'quantity_basis must be REPORTED or DERIVED_LINE_COUNT'
      when coalesce(t.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = t.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
      when coalesce(t.v ->> 'payout_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_payouts p where p.v ->> 'key' = t.v ->> 'payout_ref')
        then 'its payout_ref names no payout in this file'
      when coalesce(t.v ->> 'mapping_rule_id', '') = '' then
        case
          when t.v ->> 'category' is distinct from 'UNMAPPED'
            then 'a transaction without a mapping rule must be UNMAPPED'
          when coalesce(t.v ->> 'side', '') <> '' or coalesce(t.v ->> 'subcategory', '') <> ''
            then 'an UNMAPPED transaction has no side and no subcategory'
        end
      when mr.id is null then 'its mapping rule does not exist'
      when mr.status <> 'ACTIVE' then 'its mapping rule is retired'
      when mr.marketplace_code <> v_account.marketplace_code or mr.format_id <> v_format
        then 'its mapping rule belongs to a different marketplace or format'
      when mr.scope = 'BUSINESS' and mr.business_id is distinct from v_account.business_id
        then 'its mapping rule belongs to a different business'
      when t.v ->> 'side' is distinct from mr.side
        or t.v ->> 'category' is distinct from mr.category
        or coalesce(t.v ->> 'subcategory', '') <> coalesce(mr.subcategory, '')
        or t.v ->> 'attribution' is distinct from mr.attribution
        then 'its side, category, subcategory or attribution differ from its mapping rule'
      when mr.quantity_rule = 'NONE' and coalesce(t.v ->> 'quantity_basis', '') <> ''
        then 'its mapping rule records no quantity'
      when mr.quantity_rule = 'REPORTED' and coalesce(t.v ->> 'quantity_basis', 'REPORTED') <> 'REPORTED'
        then 'its mapping rule takes the quantity as reported'
      when mr.quantity_rule = 'COUNT_LINE' and t.v ->> 'quantity_basis' is distinct from 'DERIVED_LINE_COUNT'
        then 'its mapping rule counts the line as one unit, so quantity_basis must be DERIVED_LINE_COUNT'
    end as problem
  ) x
  where x.problem is not null
  order by t.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s has more than one transaction with line_index %s.',
                t.row_no, coalesce(t.v ->> 'line_index', '0'))
  into v_problem
  from pg_temp.ledger_in_transactions t
  group by t.row_no, coalesce(t.v ->> 'line_index', '0')
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- issues --------------------------------------------------------------
  select format('Row issue %s: %s', i.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_issues i
  cross join lateral (
    select case
      when jsonb_typeof(i.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = i.row_no)
        then 'its row_number matches no source row'
      when coalesce(i.v ->> 'severity', '') not in ('ERROR', 'WARNING')
        then 'severity must be ERROR or WARNING'
      when jsonb_typeof(i.v -> 'message') is distinct from 'string'
           or length(i.v ->> 'message') not between 1 and 500
           or public.ledger_text_has_email(i.v ->> 'message')
        then 'message is required and may not contain an email address'
      when not public.ledger_json_is_optional_text(i.v -> 'field', 120)
        or not public.ledger_json_is_optional_text(i.v -> 'raw_value', 500)
        then 'field or raw_value is too long or contains an email address'
    end as problem
  ) x
  where x.problem is not null
  order by i.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- nothing is silently dropped ------------------------------------------
  select format('Source row %s is not used by any transaction, settlement, payout or row issue. Every row must be accounted for.',
                r.row_number)
  into v_problem
  from pg_temp.ledger_rows r
  where not exists (select 1 from pg_temp.ledger_in_transactions t where t.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_settlements s where s.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_payouts p where p.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_issues i where i.row_no = r.row_number)
  order by r.row_number
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- overlap (migration 0034) --------------------------------------------
  -- Report exports can cover overlapping periods. A row identical to one in a
  -- file still counting for this account would be counted twice, so the file
  -- is refused, naming the file that already holds it.
  select format('This file repeats %s row(s) already counted from the file "%s". Withdraw that file first, or upload a period that does not overlap.',
                count(*), min(b.file_name))
  into v_problem
  from pg_temp.ledger_rows r
  join public.source_rows sr
    on sr.row_hash = encode(sha256(convert_to(r.raw::text, 'UTF8')), 'hex')
  join public.import_batches b on b.id = sr.source_file_id
  where b.marketplace_account_id = v_account.id
    and b.dataset = 'LEDGER'
    and b.withdrawn_at is null
  having count(*) > 0;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- ---- write ---------------------------------------------------------------
  perform set_config('bizmind.ledger_writer', 'on', true);

  select count(*) into v_rows from pg_temp.ledger_rows;
  select count(distinct i.row_no) into v_failed
  from pg_temp.ledger_in_issues i where i.v ->> 'severity' = 'ERROR';
  select count(*) into v_tx from pg_temp.ledger_in_transactions;

  insert into public.import_batches (
    business_id, created_by, entity, status, file_name, file_type, file_size_bytes,
    columns, raw_rows, row_count, rows_valid, rows_failed, created_count, updated_count,
    committed_at, dataset, source_kind, marketplace_account_id, format_id, adapter_version,
    file_sha256, stripped_columns
  )
  values (
    v_account.business_id, v_uid, 'LEDGER', 'COMPLETED', v_file_name, v_file_type, v_size,
    coalesce(p_file -> 'columns', '[]'), '[]', v_rows, v_rows - v_failed, v_failed, v_tx, 0,
    now(), 'LEDGER', v_source_kind, v_account.id, v_format, v_version,
    v_sha, v_stripped
  )
  returning id into v_file_id;

  insert into public.source_rows (business_id, source_file_id, row_number, raw, row_hash)
  select v_account.business_id, v_file_id, r.row_number, r.raw,
         encode(sha256(convert_to(r.raw::text, 'UTF8')), 'hex')
  from pg_temp.ledger_rows r
  order by r.row_number;

  insert into public.settlements (
    business_id, marketplace_account_id, source_file_id, source_row_id, external_settlement_id,
    period_start, period_end, reported_total, reported_deposit_date, currency
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id, s.v ->> 'external_settlement_id',
         (s.v ->> 'period_start')::timestamptz, (s.v ->> 'period_end')::timestamptz,
         (s.v ->> 'reported_total')::numeric, (s.v ->> 'reported_deposit_date')::timestamptz,
         v_account.currency
  from pg_temp.ledger_in_settlements s
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = s.row_no
  order by s.position;
  get diagnostics v_st = row_count;

  create temporary table ledger_payout_ids (key text primary key, id uuid not null) on commit drop;

  v_po := 0;
  for v_payout in
    select p.v, sr.id as source_row_id, st.id as settlement_id
    from pg_temp.ledger_in_payouts p
    join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = p.row_no
    left join public.settlements st
      on st.source_file_id = v_file_id and st.external_settlement_id = p.v ->> 'settlement_ref'
    order by p.position
  loop
    insert into public.payouts (
      business_id, marketplace_account_id, origin, source_file_id, source_row_id, settlement_id,
      external_ref, amount, currency, paid_at
    )
    values (
      v_account.business_id, v_account.id, 'SOURCE_FILE', v_file_id, v_payout.source_row_id,
      v_payout.settlement_id, v_payout.v ->> 'external_ref', (v_payout.v ->> 'amount')::numeric,
      v_account.currency, (v_payout.v ->> 'paid_at')::timestamptz
    )
    returning id into v_payout_id;

    insert into pg_temp.ledger_payout_ids (key, id) values (v_payout.v ->> 'key', v_payout_id);
    v_po := v_po + 1;
  end loop;

  insert into public.financial_transactions (
    business_id, marketplace_account_id, source_file_id, source_row_id, line_index,
    mapping_rule_id, side, category, subcategory, source_type, source_subtype, source_description,
    amount, currency, posted_at, order_ref, order_line_ref, raw_sku, quantity, quantity_basis,
    attribution, settlement_id, payout_id, external_ref
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id,
         coalesce((t.v ->> 'line_index')::smallint, 0),
         nullif(t.v ->> 'mapping_rule_id', '')::uuid,
         nullif(t.v ->> 'side', ''), t.v ->> 'category', nullif(t.v ->> 'subcategory', ''),
         t.v ->> 'source_type', t.v ->> 'source_subtype', t.v ->> 'source_description',
         (t.v ->> 'amount')::numeric, v_account.currency, (t.v ->> 'posted_at')::timestamptz,
         t.v ->> 'order_ref', t.v ->> 'order_line_ref', t.v ->> 'raw_sku',
         (t.v ->> 'quantity')::numeric, nullif(t.v ->> 'quantity_basis', ''),
         t.v ->> 'attribution', st.id, po.id, t.v ->> 'external_ref'
  from pg_temp.ledger_in_transactions t
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = t.row_no
  left join public.settlements st
    on st.source_file_id = v_file_id and st.external_settlement_id = t.v ->> 'settlement_ref'
  left join pg_temp.ledger_payout_ids po on po.key = t.v ->> 'payout_ref'
  order by t.position;

  insert into public.import_issues (business_id, batch_id, row_number, severity, field, message, raw_value)
  select v_account.business_id, v_file_id, i.row_no, i.v ->> 'severity', i.v ->> 'field',
         i.v ->> 'message', i.v ->> 'raw_value'
  from pg_temp.ledger_in_issues i
  order by i.position;
  get diagnostics v_is = row_count;

  select count(*) into v_unmapped
  from public.financial_transactions ft
  where ft.source_file_id = v_file_id and ft.category = 'UNMAPPED';

  perform public.write_audit_log(
    v_account.business_id, 'ledger.file_applied', 'import_batches', v_file_id, null,
    jsonb_build_object(
      'file_name', v_file_name,
      'format_id', v_format,
      'adapter_version', v_version,
      'file_sha256', v_sha,
      'marketplace_account_id', v_account.id,
      'rows', v_rows,
      'transactions', v_tx,
      'settlements', v_st,
      'payouts', v_po,
      'issues', v_is,
      'unmapped', v_unmapped,
      'stripped_columns', to_jsonb(v_stripped),
      'totals', (
        select coalesce(jsonb_object_agg(x.k, x.total), '{}')
        from (
          select coalesce(ft.side, 'UNMAPPED') || '.' || ft.category as k, sum(ft.amount)::text as total
          from public.financial_transactions ft
          where ft.source_file_id = v_file_id
          group by 1
        ) x
      )
    )
  );

  return query select v_file_id, false, v_rows, v_tx, v_st, v_po, v_is, v_unmapped;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. ledger_classified_lines: expose external_ref
-- ----------------------------------------------------------------------------
-- Appended at the end of the select list, so every existing reader of this
-- view is unaffected (LEDGER.md: columns are only appended).

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

-- ----------------------------------------------------------------------------
-- 4. The two new formats: recognised, optional, on the existing Amazon adapter
-- ----------------------------------------------------------------------------

update public.marketplaces set adapter_status = 'AVAILABLE' where code = 'AMAZON';

with kinds (description, slug, vat_already_in_settlement, label) as (
  values
    ('Sales Commission',      'referral',              false, 'Referral commission'),
    ('Refund Commission',     'refund_administration',  false, 'Refund administration fee'),
    ('Variable Closing Fee',  'closing',                false, 'Variable closing fee'),
    ('Multitier Per Unit Fee','multitier_per_unit',     false, 'Multitier per-unit fee'),
    ('Shipping Chargeback',   'shipping_chargeback',    false, 'Shipping chargeback'),
    ('COD Chargeback Fee',    'cod',                    false, 'COD chargeback fee'),
    ('Paid Services Fee',     'premium_services',       true,  'SP 360 premium services')
),
formats (source_type, format_id) as (
  values ('TaxInvoice', 'amazon.tax_invoice'), ('TaxCreditNote', 'amazon.tax_credit_note')
)
insert into public.ledger_mapping_rules (
  scope, business_id, marketplace_code, format_id, match_key, match, side, category, subcategory,
  sign_rule, quantity_rule, attribution, confidence, evidence, version, status
)
select 'GLOBAL', null, 'AMAZON', r.format_id, r.match_key, r.match, r.side, r.category, r.subcategory,
       'AS_REPORTED', 'NONE', 'MARKETPLACE', 'SAMPLE_VERIFIED', r.evidence, 1, 'ACTIVE'
from (
  select
    f.format_id,
    f.source_type || '|FeeExclTax|' || k.description as match_key,
    jsonb_build_object('source_type', f.source_type, 'source_subtype', 'FeeExclTax', 'source_description', k.description) as match,
    'MEMO'::text as side,
    'INFORMATIONAL'::text as category,
    k.slug || '_excl_vat' as subcategory,
    'The fee amount this tax document states for ' || k.description || '. Already recorded as a fee '
      || 'through the settlement (this document restates it for VAT purposes); kept here for '
      || 'traceability, never counted in profit. Owner decision 2026-09-28.' as evidence
  from formats f cross join kinds k
  union all
  select
    f.format_id,
    f.source_type || '|VAT|' || k.description,
    jsonb_build_object('source_type', f.source_type, 'source_subtype', 'VAT', 'source_description', k.description),
    case when k.vat_already_in_settlement then 'MEMO' else 'TAX' end,
    case when k.vat_already_in_settlement then 'INFORMATIONAL' else 'FEE_VAT' end,
    k.slug || '_vat',
    case when k.vat_already_in_settlement
      then 'The settlement already reports ' || k.description || ' with its VAT included in one '
        || 'combined line (migration 0044). This document repeats it; kept for traceability, never '
        || 'counted again. Owner decision 2026-09-28.'
      else '5% VAT on ' || k.description || ', charged by Amazon but not itemised on the settlement '
        || 'report -- only this tax document states it. Owner decision 2026-09-28.'
    end
  from formats f cross join kinds k
) r
where not exists (
  select 1 from public.ledger_mapping_rules existing
  where existing.business_id is null
    and existing.marketplace_code = 'AMAZON'
    and existing.format_id = r.format_id
    and existing.match_key = r.match_key
);

with kinds (description, slug, vat_already_in_settlement, label) as (
  values
    ('Sales Commission',      'referral',              false, 'Referral commission'),
    ('Refund Commission',     'refund_administration',  false, 'Refund administration fee'),
    ('Variable Closing Fee',  'closing',                false, 'Variable closing fee'),
    ('Multitier Per Unit Fee','multitier_per_unit',     false, 'Multitier per-unit fee'),
    ('Shipping Chargeback',   'shipping_chargeback',    false, 'Shipping chargeback'),
    ('COD Chargeback Fee',    'cod',                    false, 'COD chargeback fee'),
    ('Paid Services Fee',     'premium_services',       true,  'SP 360 premium services')
),
formats (source_type, format_id) as (
  values ('TaxInvoice', 'amazon.tax_invoice'), ('TaxCreditNote', 'amazon.tax_credit_note')
)
insert into public.classification_rules (
  scope, business_id, marketplace_code, format_id, match_key, category, subcategory, confidence, evidence
)
select 'GLOBAL', null, 'AMAZON', r.format_id, r.match_key, r.category, r.subcategory, 'HIGH', r.evidence
from (
  select
    f.format_id,
    f.source_type || '|FeeExclTax|' || k.description as match_key,
    'INFORMATIONAL' as category,
    k.label || ' (excl. VAT)' as subcategory,
    'The fee this document states for ' || k.label || '. Already a marketplace fee through the '
      || 'settlement; this is Amazon''s own restatement for VAT purposes, kept for traceability, '
      || 'never counted again. Owner decision 2026-09-28.' as evidence
  from formats f cross join kinds k
  union all
  select
    f.format_id,
    f.source_type || '|VAT|' || k.description,
    case when k.vat_already_in_settlement then 'INFORMATIONAL' else 'INPUT_VAT' end,
    case when k.vat_already_in_settlement then k.label || ' VAT (in settlement)' else 'VAT on ' || lower(k.label) end,
    case when k.vat_already_in_settlement
      then 'The settlement already reports ' || k.label || ' with its VAT included in one combined '
        || 'line (migration 0044). This document repeats it; kept for traceability, never counted '
        || 'again. Owner decision 2026-09-28.'
      else '5% VAT on ' || lower(k.label) || ', charged by Amazon but not itemised on the settlement '
        || 'report; only this tax document states it. Its P&L effect follows the account VAT setting '
        || '(B1), exactly like the existing SP 360 VAT rule. Owner decision 2026-09-28.'
    end
  from formats f cross join kinds k
) r
where not exists (
  select 1 from public.classification_rules existing
  where existing.business_id is null
    and existing.marketplace_code = 'AMAZON'
    and existing.format_id = r.format_id
    and existing.match_key = r.match_key
    and existing.status = 'ACTIVE'
);

-- ----------------------------------------------------------------------------
-- 5. Self-check
-- ----------------------------------------------------------------------------

do $$
declare
  v_mapping_count integer;
  v_classification_count integer;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'financial_transactions' and column_name = 'external_ref'
  ) then
    raise exception 'SELF-CHECK: financial_transactions.external_ref is missing.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ledger_classified_lines' and column_name = 'external_ref'
  ) then
    raise exception 'SELF-CHECK: ledger_classified_lines.external_ref is missing.';
  end if;

  select count(*) into v_mapping_count from public.ledger_mapping_rules
  where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
    and format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note');
  if v_mapping_count <> 28 then
    raise exception 'SELF-CHECK: expected 28 active tax-document mapping rules, found %.', v_mapping_count;
  end if;

  select count(*) into v_classification_count from public.classification_rules
  where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
    and format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note');
  if v_classification_count <> 28 then
    raise exception 'SELF-CHECK: expected 28 active tax-document classification rules, found %.', v_classification_count;
  end if;

  -- The duplicate (Paid Services Fee) stays informational on both sides.
  if not exists (
    select 1 from public.classification_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and format_id = 'amazon.tax_invoice' and match_key = 'TaxInvoice|VAT|Paid Services Fee'
      and category = 'INFORMATIONAL'
  ) then
    raise exception 'SELF-CHECK: Paid Services Fee VAT from the tax invoice must be INFORMATIONAL.';
  end if;

  -- A genuinely new VAT line (never on the settlement) must be INPUT_VAT / FEE_VAT.
  if not exists (
    select 1 from public.classification_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and format_id = 'amazon.tax_invoice' and match_key = 'TaxInvoice|VAT|Sales Commission'
      and category = 'INPUT_VAT'
  ) or not exists (
    select 1 from public.ledger_mapping_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and format_id = 'amazon.tax_invoice' and match_key = 'TaxInvoice|VAT|Sales Commission'
      and side = 'TAX' and category = 'FEE_VAT'
  ) then
    raise exception 'SELF-CHECK: Sales Commission VAT from the tax invoice must be FEE_VAT / INPUT_VAT.';
  end if;

  -- The fee-excl-tax restatement is always informational, on both formats.
  if not exists (
    select 1 from public.ledger_mapping_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and format_id = 'amazon.tax_credit_note' and match_key = 'TaxCreditNote|FeeExclTax|Shipping Chargeback'
      and side = 'MEMO' and category = 'INFORMATIONAL'
  ) then
    raise exception 'SELF-CHECK: a credit note''s fee-excl-tax restatement must be INFORMATIONAL.';
  end if;

  raise notice 'Migration 0057 verified: external_ref added, ledger_apply_file() accepts pdf, % tax-document rules seeded on each side.', v_mapping_count;
end;
$$;

commit;
