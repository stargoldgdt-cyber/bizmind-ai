-- ============================================================================
-- 0072  perf_lab(): times each layer of the P&L, and checks a faster shape
-- ============================================================================
-- A TEMPORARY, READ-ONLY measuring tool (owner approved the performance work,
-- 2026-10-07: faster queries, no change to any figure or rule).
--
-- The dashboard and the Product Profit page are slow because pnl_summary() and
-- pnl_by_product() spend ~2.5 s per month. Before changing them, this function
-- times, on the real data and as the signed-in user (row-level security
-- included), each layer on its own:
--
--   1  the raw lines                         (the floor: just reading them)
--   2  + classification   (ledger_classified_lines)
--   3  + product, cost and refund credit      (ledger_product_lines)
--   4  the same without the refund credit     (the pre-0071 view, written inline)
--   5  a faster shape: classify each distinct line TYPE once, then total
--   6  pnl_summary()      7  pnl_by_product()
--
-- Steps 2 and 5 also return the same totals, so the faster shape can be checked
-- for IDENTICAL figures before anything is built on it. Each step runs twice
-- (the second shows the warm cache). It changes no data and no existing object.
-- It is dropped again once the optimisation is done.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.perf_lab(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (step text, ms numeric, result text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t0 timestamptz;
  v  text;
  pass integer;
begin
  for pass in 1..2 loop

    -- 1. the raw lines
    t0 := clock_timestamp();
    select 'lines=' || count(*) || ' sum=' || coalesce(sum(ft.amount), 0)::numeric(20,4)
      into v
    from public.financial_transactions ft
    where ft.business_id = p_business_id and ft.posted_at >= p_from and ft.posted_at < p_to;
    step := '1 raw lines (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := v; return next;

    -- 2. classification per line (the view)
    t0 := clock_timestamp();
    select 'lines=' || count(*)
        || ' gross=' || coalesce(sum(l.amount::numeric) filter (where l.metric_group = 'GROSS_SALES'), 0)::numeric(20,4)
        || ' refunds=' || coalesce(sum(l.amount::numeric) filter (where l.metric_group = 'SALES_REFUNDS'), 0)::numeric(20,4)
        || ' fees=' || coalesce(sum(l.amount::numeric) filter (where l.metric_group = 'MARKETPLACE_FEES'), 0)::numeric(20,4)
        || ' known=' || coalesce(sum(l.amount::numeric) filter (where l.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)::numeric(20,4)
      into v
    from public.ledger_classified_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to;
    step := '2 classified lines (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := v; return next;

    -- 3. product, cost and refund credit (the view as it is now)
    t0 := clock_timestamp();
    select 'lines=' || count(*) || ' cogs=' || coalesce(sum(l.cogs::numeric) filter (where l.cogs_status = 'COSTED'), 0)::numeric(20,4)
      into v
    from public.ledger_product_lines l
    where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to;
    step := '3 product lines, with refund credit (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := v; return next;

    -- 4. the same without the refund credit: the view as it was before 0071, written inline
    t0 := clock_timestamp();
    select 'lines=' || count(*) || ' cogs=' || coalesce(sum(x.cogs::numeric) filter (where x.cogs_status = 'COSTED'), 0)::numeric(20,4)
      into v
    from (
      select
        case
          when not (l.category = 'PRODUCT_SALES' and l.quantity is not null) then 'NOT_APPLICABLE'
          when al.product_id is null then 'NO_PRODUCT'
          when pc.unit_cost is null then 'NO_COST'
          else 'COSTED'
        end as cogs_status,
        case
          when l.category = 'PRODUCT_SALES' and l.quantity is not null and pc.unit_cost is not null
            then (-(l.quantity::numeric(20,4) * pc.unit_cost))::numeric(20,4)::text
        end as cogs
      from public.ledger_classified_lines l
      left join public.sku_aliases al
        on al.business_id = l.business_id and al.marketplace_code = l.marketplace_code
       and al.raw_sku = l.raw_sku and al.status = 'CONFIRMED'
      left join lateral (
        select pcost.unit_cost
        from public.product_costs pcost
        where pcost.product_id = al.product_id and pcost.currency = l.currency and pcost.retired_at is null
          and pcost.effective_from <= (l.posted_at at time zone 'UTC')::date
        order by pcost.effective_from desc, pcost.created_at desc
        limit 1
      ) pc on true
      where l.business_id = p_business_id and l.posted_at >= p_from and l.posted_at < p_to
    ) x;
    step := '4 product lines, no refund credit (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := v; return next;

    -- 5. a faster shape: classify each distinct line type once, then total
    t0 := clock_timestamp();
    select 'lines=' || sum(t.n) || ' types=' || count(*)
        || ' gross=' || coalesce(sum(t.amt) filter (where c.metric_group = 'GROSS_SALES'), 0)::numeric(20,4)
        || ' refunds=' || coalesce(sum(t.amt) filter (where c.metric_group = 'SALES_REFUNDS'), 0)::numeric(20,4)
        || ' fees=' || coalesce(sum(t.amt) filter (where c.metric_group = 'MARKETPLACE_FEES'), 0)::numeric(20,4)
        || ' known=' || coalesce(sum(t.amt) filter (where
             (case
                when r.id is null then null
                when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
                when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
                when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
                else 'CONDITIONAL'
              end) in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)::numeric(20,4)
      into v
    from (
      select
        ft.marketplace_account_id,
        a.marketplace_code,
        b.format_id,
        public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
        count(*) as n,
        sum(ft.amount::numeric(20,4)) as amt
      from public.financial_transactions ft
      join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
      join public.marketplace_accounts a on a.id = ft.marketplace_account_id
      where ft.business_id = p_business_id and ft.posted_at >= p_from and ft.posted_at < p_to
      group by 1, 2, 3, 4
    ) t
    left join public.tax_profiles tp on tp.marketplace_account_id = t.marketplace_account_id
    left join lateral (
      select cr.id, cr.category
      from public.classification_rules cr
      where cr.status = 'ACTIVE'
        and cr.marketplace_code = t.marketplace_code
        and cr.format_id = t.format_id
        and cr.match_key = t.match_key
        and (cr.business_id is null or cr.business_id = p_business_id)
      order by case
                 when cr.business_id is null and cr.confidence = 'HIGH' then 1
                 when cr.business_id is not null then 2
                 else 3
               end
      limit 1
    ) r on true
    left join public.classification_categories c on c.code = r.category;
    step := '5 classify each line type once (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := v; return next;

    -- 6. pnl_summary()
    t0 := clock_timestamp();
    perform 1 from public.pnl_summary(p_from, p_to, null, p_business_id, false);
    step := '6 pnl_summary (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := ''; return next;

    -- 7. pnl_by_product()
    t0 := clock_timestamp();
    perform 1 from public.pnl_by_product(p_from, p_to, null, p_business_id);
    step := '7 pnl_by_product (pass ' || pass || ')'; ms := round(extract(epoch from clock_timestamp() - t0) * 1000); result := ''; return next;

  end loop;
end;
$$;

revoke all on function public.perf_lab(uuid, timestamptz, timestamptz) from anon, public;
grant execute on function public.perf_lab(uuid, timestamptz, timestamptz) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'perf_lab'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: perf_lab must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0072 verified: perf_lab is a read-only, invoker-rights measuring tool.';
end;
$$;

commit;
