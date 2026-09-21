-- ============================================================================
-- 0047  The SKU queue classifies line TYPES, not every line
-- ============================================================================
-- After 0046 the dashboard loads in under 2 seconds on the owner's data, but
-- sku_mapping_queue() still took 8 seconds: most of the ~33,000 lines are noon
-- lines whose SKUs have no product yet, and the classified-lines view looks up
-- a classification rule for each line.
--
-- A line's classification depends only on its marketplace, file format and
-- match key. So the unmatched lines are first grouped by SKU, account and
-- line type (a plain GROUP BY on the ledger), and each group -- a few hundred,
-- not tens of thousands -- is classified once, with EXACTLY the rule choice
-- the ledger_classified_lines view makes (same filter, same priority). The
-- result is identical; only the order of work changes.
--
-- Same signature and result shape as 0035/0046. Also orders by marketplace
-- after SKU, so pages never overlap. Nothing in the ledger, classification,
-- VAT or P&L changes.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.sku_mapping_queue(p_business_id uuid)
returns table (
  marketplace_code text,
  raw_sku          text,
  accounts         text,
  currencies       text,
  lines            bigint,
  units_sold       text,
  net_sales        text,
  first_seen       timestamptz,
  last_seen        timestamptz,
  sample_title     text,
  suggestions      jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
with groups as (
  -- Unmatched lines, grouped by SKU, account and line type. No per-line lookup.
  select
    a.marketplace_code,
    a.label                                                                     as account_label,
    ft.currency::text                                                           as currency,
    ft.raw_sku,
    b.format_id,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
    count(*)                                                                    as lines,
    sum(ft.amount)                                                              as amount,
    sum(ft.quantity)                                                            as quantity,
    min(ft.posted_at)                                                           as first_seen,
    max(ft.posted_at)                                                           as last_seen,
    (array_agg(ft.source_row_id order by ft.posted_at, ft.line_index))[1]       as first_row
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where ft.business_id = p_business_id
    and ft.raw_sku is not null
    and not exists (
      select 1 from public.sku_aliases s
      where s.business_id = p_business_id and s.marketplace_code = a.marketplace_code
        and s.raw_sku = ft.raw_sku and s.status = 'CONFIRMED'
    )
  group by a.marketplace_code, a.label, ft.currency, ft.raw_sku, b.format_id,
           public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
),
classified as (
  -- Each line type once, with the rule the ledger_classified_lines view picks.
  select g.*, r.category, c.metric_group
  from groups g
  left join lateral (
    select cr.category
    from public.classification_rules cr
    where cr.status = 'ACTIVE'
      and cr.marketplace_code = g.marketplace_code
      and cr.format_id = g.format_id
      and cr.match_key = g.match_key
      and (cr.business_id is null or cr.business_id = p_business_id)
    order by case
               when cr.business_id is null and cr.confidence = 'HIGH' then 1
               when cr.business_id is not null then 2
               else 3
             end
    limit 1
  ) r on true
  left join public.classification_categories c on c.code = r.category
),
unmapped as (
  select
    k.marketplace_code,
    k.raw_sku,
    string_agg(distinct k.account_label, ', ')                                  as accounts,
    string_agg(distinct k.currency, ', ')                                       as currencies,
    sum(k.lines)::bigint                                                        as lines,
    coalesce(sum(k.quantity) filter (where k.category = 'PRODUCT_SALES'), 0)    as units,
    coalesce(sum(k.amount) filter (where k.metric_group in
      ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)                 as net_sales,
    min(k.first_seen)                                                           as first_seen,
    max(k.last_seen)                                                            as last_seen,
    (array_agg(k.first_row order by k.first_seen))[1]                           as sample_row
  from classified k
  group by k.marketplace_code, k.raw_sku
)
select
  u.marketplace_code,
  u.raw_sku,
  u.accounts,
  u.currencies,
  u.lines,
  u.units::numeric(20,4)::text,
  u.net_sales::numeric(20,4)::text,
  u.first_seen,
  u.last_seen,
  (select nullif(trim(sr.raw ->> 'Title'), '') from public.source_rows sr where sr.id = u.sample_row),
  coalesce((
    select jsonb_agg(distinct jsonb_build_object('product_id', c.id, 'name', c.name, 'reason', c.reason))
    from (
      select p.id, p.name, 'SAME_SKU_CODE' as reason
      from public.catalog_products p
      where p.business_id = p_business_id
        and p.status = 'ACTIVE'
        and p.sku_code is not null
        and public.sku_normalize(p.sku_code) = public.sku_normalize(u.raw_sku)
      union
      select p.id, p.name, 'MAPPED_ON_OTHER_MARKETPLACE'
      from public.sku_aliases a
      join public.catalog_products p on p.id = a.product_id
      where a.business_id = p_business_id
        and a.status = 'CONFIRMED'
        and a.marketplace_code <> u.marketplace_code
        and p.status = 'ACTIVE'
        and public.sku_normalize(a.raw_sku) = public.sku_normalize(u.raw_sku)
    ) c
    where not exists (
      select 1 from public.sku_aliases r
      where r.business_id = p_business_id
        and r.marketplace_code = u.marketplace_code
        and r.raw_sku = u.raw_sku
        and r.product_id = c.id
        and r.status = 'REJECTED'
    )
  ), '[]'::jsonb)
from unmapped u
order by u.net_sales desc, u.raw_sku, u.marketplace_code;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sku_mapping_queue'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: sku_mapping_queue must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0047 verified: the SKU queue classifies line types once.';
end;
$$;

commit;
