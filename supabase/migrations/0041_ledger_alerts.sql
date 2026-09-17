-- ============================================================================
-- 0041  Alerts on ledger figures
-- ============================================================================
-- GCC Phase 9, part 1. The automation engine (0016-0017) watched the legacy
-- analytics. A rule can now watch a figure computed from the marketplace
-- ledger, for one currency:
--
--   ledger_net_sales               net sales
--   ledger_marketplace_fees        marketplace fees, as a positive amount
--   ledger_advertising             marketplace advertising, as a positive amount
--   ledger_contribution            contribution            (NULL unless final)
--   ledger_gross_profit            gross profit            (NULL unless final)
--   ledger_net_profit              net profit              (NULL unless final)
--   ledger_expected_payouts        expected marketplace payouts by expected date
--                                  (never money received)
--   ledger_unknown_lines           lines with an unrecognised code (a count)
--   ledger_settlements_mismatched  settlements that do not add up (a count)
--
-- THE RULES THAT KEEP THESE ALERTS HONEST
--   * Every figure comes from the same SQL readers as the screens
--     (pnl_summary, pnl_net_profit, expected_payouts): an alert can never
--     disagree with the page it links to.
--   * A figure that is not final never raises an alarm: the run is SKIPPED
--     with INCOMPLETE_DATA and the reasons are recorded. With
--     suppress_when_incomplete on (the default), that applies to sales, fees
--     and advertising too while any line is unrecognised.
--   * No marketplace figures in the window is METRIC_NULL, never zero.
--   * A percentage change needs a non-zero figure in the window before
--     (NO_PREVIOUS_VALUE otherwise); counts are watched by value only.
--   * The currency is part of the rule: amounts in different currencies are
--     never compared or combined (A12).
--
-- Legacy rules are evaluated exactly as before.
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0040.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The vocabulary and the rule's currency
-- ----------------------------------------------------------------------------

insert into public.canonical_metrics (key, origin) values
  ('ledger_net_sales', 'computed'),
  ('ledger_marketplace_fees', 'computed'),
  ('ledger_advertising', 'computed'),
  ('ledger_contribution', 'computed'),
  ('ledger_gross_profit', 'computed'),
  ('ledger_net_profit', 'computed'),
  ('ledger_expected_payouts', 'computed'),
  ('ledger_unknown_lines', 'computed'),
  ('ledger_settlements_mismatched', 'computed');

alter table public.automation_rules
  add column ledger_currency char(3) check (ledger_currency is null or ledger_currency ~ '^[A-Z]{3}$');

alter table public.automation_rules
  add constraint automation_rules_ledger_metric_currency_check
  check ((metric like 'ledger\_%') = (ledger_currency is not null));

alter table public.alerts
  add column currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$');

comment on column public.alerts.currency is
  'The currency of a ledger alert''s figures, copied from its rule. NULL for a '
  'legacy alert, which is in the business currency.';

comment on column public.automation_rules.ledger_currency is
  'For a ledger metric, the currency whose marketplace accounts are watched '
  '(all accounts in it, added up). Required for ledger metrics, absent otherwise.';


-- ----------------------------------------------------------------------------
-- 2. One ledger figure, for one business, currency and window
-- ----------------------------------------------------------------------------

/**
 * Returns the figure a ledger rule watches, or NULL with the reason it cannot
 * be judged. Reads only; used by the evaluator, never by a person.
 */
create function public.automation_ledger_value(
  p_business_id uuid,
  p_metric      text,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_suppress    boolean
)
returns table (value numeric, skipped text, reasons text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_found     boolean := false;
  v_net_sales numeric;
  v_fees      numeric;
  v_ads       numeric;
  v_unknown   bigint;
  v_figures   text;
  v_reasons   text[];
  v_contrib   text;
  v_gross     text;
  v_net       text;
  v_net_why   text[];
  v_expected  numeric;
  v_mismatch  bigint;
begin
  if p_metric in ('ledger_net_sales', 'ledger_marketplace_fees', 'ledger_advertising', 'ledger_unknown_lines') then
    select true, s.net_sales::numeric, s.marketplace_fees::numeric, s.advertising::numeric,
           s.unknown_lines, s.figures_status, s.incomplete_reasons
      into v_found, v_net_sales, v_fees, v_ads, v_unknown, v_figures, v_reasons
    from public.pnl_summary(p_from, p_to, null, p_business_id, true) s
    where s.currency = p_currency;

    if not coalesce(v_found, false) then
      return query select null::numeric, 'METRIC_NULL'::text, '{}'::text[];
      return;
    end if;
    if p_metric = 'ledger_unknown_lines' then
      return query select v_unknown::numeric, null::text, v_reasons;
      return;
    end if;
    if p_suppress and v_figures <> 'FINAL' then
      return query select null::numeric, 'INCOMPLETE_DATA'::text, v_reasons;
      return;
    end if;
    return query select
      case p_metric
        when 'ledger_net_sales' then v_net_sales
        when 'ledger_marketplace_fees' then -v_fees
        else -v_ads
      end,
      null::text, v_reasons;
    return;
  end if;

  if p_metric in ('ledger_contribution', 'ledger_gross_profit', 'ledger_net_profit') then
    select true, n.contribution, n.gross_profit, n.net_profit, n.net_profit_reasons
      into v_found, v_contrib, v_gross, v_net, v_net_why
    from public.pnl_net_profit(p_from, p_to, p_business_id) n
    where n.currency = p_currency and n.accounts > 0;

    if not coalesce(v_found, false) then
      return query select null::numeric, 'METRIC_NULL'::text, '{}'::text[];
      return;
    end if;
    return query select
      (case p_metric
        when 'ledger_contribution' then v_contrib
        when 'ledger_gross_profit' then v_gross
        else v_net
      end)::numeric,
      case when (case p_metric
                   when 'ledger_contribution' then v_contrib
                   when 'ledger_gross_profit' then v_gross
                   else v_net
                 end) is null then 'INCOMPLETE_DATA' end,
      coalesce(v_net_why, '{}'::text[]);
    return;
  end if;

  if p_metric in ('ledger_expected_payouts', 'ledger_settlements_mismatched') then
    select sum(e.expected_amount::numeric), count(*) filter (where e.marketplace_status = 'DOES_NOT_ADD_UP')
      into v_expected, v_mismatch
    from public.expected_payouts(p_business_id, p_from, p_to, null) e
    where e.currency = p_currency;

    if p_metric = 'ledger_settlements_mismatched' then
      return query select coalesce(v_mismatch, 0)::numeric, null::text, '{}'::text[];
      return;
    end if;
    return query select v_expected, case when v_expected is null then 'METRIC_NULL' end, '{}'::text[];
    return;
  end if;

  return query select null::numeric, 'NO_ANALYTICS_KEY'::text, '{}'::text[];
end;
$$;

revoke all on function public.automation_ledger_value(uuid, text, text, timestamptz, timestamptz, boolean)
  from anon, authenticated, public;


-- ----------------------------------------------------------------------------
-- 3. The evaluator, with a ledger branch
-- ----------------------------------------------------------------------------
-- 0017's function with the ledger branch added; the legacy path is unchanged.

create or replace function public.automation_evaluate_rule(p_rule_id uuid)
returns public.automation_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule       public.automation_rules;
  v_actor      uuid := (select auth.uid());
  v_key        text;
  v_from       timestamptz;
  v_to         timestamptz;
  v_prev_from  timestamptz;
  v_financials jsonb;
  v_value      numeric;
  v_value_text text;
  v_cost_cov   numeric;
  v_fee_cov    numeric;
  v_is_change  boolean;
  v_matched    boolean := false;
  v_status     public.automation_run_status;
  v_run        public.automation_runs;
  v_alert      public.alerts;
  v_skipped    text;
  v_direction  text;
  v_ledger     boolean;
  v_prev       numeric;
  v_prev_skip  text;
  v_reasons    text[];
  v_label      text;
begin
  select * into v_rule from public.automation_rules where id = p_rule_id;

  if v_rule.id is null then
    raise exception 'No such automation rule.' using errcode = 'P0002';
  end if;

  -- A person must belong to the business. The worker has no session, and is
  -- trusted because only service_role can reach the claim function at all.
  if v_actor is not null and not exists (
    select 1 from public.business_members bm
    where bm.business_id = v_rule.business_id and bm.user_id = v_actor
  ) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;

  v_to        := now();
  v_from      := v_to - make_interval(days => v_rule.period_days);
  v_prev_from := v_from - make_interval(days => v_rule.period_days);
  v_is_change := v_rule.operator in ('CHANGE_PCT_LT', 'CHANGE_PCT_GT');

  select cm.analytics_key into v_key
  from public.canonical_metrics cm where cm.key = v_rule.metric;

  -- GCC Phase 9: a figure from the marketplace ledger, for one currency.
  v_ledger := v_rule.metric like 'ledger\_%';

  if not v_rule.enabled then
    v_skipped := 'DISABLED';
  elsif v_ledger and v_rule.ledger_currency is null then
    v_skipped := 'NO_CURRENCY';
  elsif v_ledger and v_is_change
        and v_rule.metric in ('ledger_unknown_lines', 'ledger_settlements_mismatched') then
    v_skipped := 'NO_COMPARISON';
  elsif v_key is null and not v_ledger then
    v_skipped := 'NO_ANALYTICS_KEY';
  elsif v_is_change and not v_ledger and v_key not in (
      'revenue', 'cogs', 'fees', 'gross_profit', 'gross_margin', 'expenses',
      'net_profit', 'net_margin', 'orders_count', 'units_sold',
      'avg_order_value', 'customers_count', 'refunds', 'cost_coverage') then
    v_skipped := 'NO_COMPARISON';
  elsif exists (
    select 1 from public.automation_runs r
    where r.rule_id = v_rule.id
      and r.status = 'FIRED'
      and r.evaluated_at > now() - make_interval(hours => v_rule.cooldown_hours)
  ) then
    v_skipped := 'COOLDOWN';
  end if;

  if v_skipped is null and v_ledger then
    select l.value, l.skipped, l.reasons into v_value, v_skipped, v_reasons
    from public.automation_ledger_value(
      v_rule.business_id, v_rule.metric, v_rule.ledger_currency::text, v_from, v_to,
      v_rule.suppress_when_incomplete) l;

    if v_skipped is null and v_is_change then
      select l.value, l.skipped into v_prev, v_prev_skip
      from public.automation_ledger_value(
        v_rule.business_id, v_rule.metric, v_rule.ledger_currency::text, v_prev_from, v_from,
        v_rule.suppress_when_incomplete) l;

      if v_prev is null or v_prev = 0 then
        v_skipped := 'NO_PREVIOUS_VALUE';
        v_value := null;
      else
        v_value := round((v_value - v_prev) / abs(v_prev) * 100, 2);
      end if;
    end if;

    v_value_text := v_value::text;
    if v_skipped is not null and v_reasons is not null and cardinality(v_reasons) > 0 then
      v_skipped := v_skipped || ':' || array_to_string(v_reasons, ',');
    end if;
  elsif v_skipped is null then
    select to_jsonb(f) into v_financials
    from public.analytics_financials(v_rule.business_id, v_from, v_to) f;

    if v_is_change then
      select c.percent_change::numeric into v_value
      from public.analytics_compare(
             v_rule.business_id, v_from, v_to, v_prev_from, v_from) c
      where c.metric = v_key;
    else
      v_value := (v_financials ->> v_key)::numeric;
    end if;

    v_value_text := v_value::text;

    if v_value is null then
      v_skipped := 'METRIC_NULL';
    else
      v_cost_cov := (v_financials ->> 'cost_coverage')::numeric;
      v_fee_cov  := (v_financials ->> 'fee_coverage')::numeric;

      if v_rule.suppress_when_incomplete
         and v_rule.metric in
             ('gross_profit', 'gross_margin', 'net_profit', 'net_margin')
         and (coalesce(v_cost_cov, 0) < 100 or coalesce(v_fee_cov, 0) < 100)
      then
        v_skipped := 'INCOMPLETE_DATA';
      end if;
    end if;
  end if;

  if v_skipped is null then
    v_matched := case v_rule.operator
      when 'LT'  then v_value <  v_rule.threshold
      when 'LTE' then v_value <= v_rule.threshold
      when 'GT'  then v_value >  v_rule.threshold
      when 'GTE' then v_value >= v_rule.threshold
      when 'CHANGE_PCT_LT' then v_value < v_rule.threshold
      when 'CHANGE_PCT_GT' then v_value > v_rule.threshold
    end;
  end if;

  v_status := case
    when v_skipped is not null then 'SKIPPED'::public.automation_run_status
    when v_matched             then 'FIRED'::public.automation_run_status
    else                            'NOT_MATCHED'::public.automation_run_status
  end;

  insert into public.automation_runs (
    business_id, rule_id, status, metric_value, threshold, skipped_reason
  )
  values (
    v_rule.business_id, v_rule.id, v_status,
    v_value_text, v_rule.threshold::text, v_skipped
  )
  returning * into v_run;

  update public.automation_rules
  set next_run_at = now() + make_interval(mins => v_rule.evaluate_every_minutes)
  where id = v_rule.id;

  if v_status <> 'FIRED' then
    return v_run;
  end if;

  v_label := case v_rule.metric
    when 'ledger_net_sales' then 'Net sales'
    when 'ledger_marketplace_fees' then 'Marketplace fees'
    when 'ledger_advertising' then 'Marketplace advertising'
    when 'ledger_contribution' then 'Contribution'
    when 'ledger_gross_profit' then 'Gross profit'
    when 'ledger_net_profit' then 'Net profit'
    when 'ledger_expected_payouts' then 'Expected marketplace payouts'
    when 'ledger_unknown_lines' then 'Unrecognised marketplace lines'
    when 'ledger_settlements_mismatched' then 'Settlements that do not add up'
    else v_rule.metric
  end;
  if v_ledger then
    v_label := v_label || ' (' || v_rule.ledger_currency || ')';
  end if;

  v_direction := case v_rule.operator
    when 'LT'  then 'below'
    when 'LTE' then 'at or below'
    when 'GT'  then 'above'
    when 'GTE' then 'at or above'
    when 'CHANGE_PCT_LT' then 'down more than'
    when 'CHANGE_PCT_GT' then 'up more than'
  end;

  insert into public.alerts (
    business_id, rule_id, run_id, severity, title, body,
    metric, metric_value, threshold, period_days, operator, currency
  )
  values (
    v_rule.business_id, v_rule.id, v_run.id, v_rule.severity,
    v_rule.name,
    case when v_is_change then
      format(
        '%s changed by %s%% over the last %s days compared with the %s before, '
        'which is %s %s%%.',
        v_label, v_value_text, v_rule.period_days::text,
        v_rule.period_days::text, v_direction, v_rule.threshold::text
      )
    else
      format(
        '%s over the last %s days is %s, which is %s %s.',
        v_label, v_rule.period_days::text, v_value_text,
        v_direction, v_rule.threshold::text
      )
    end,
    v_rule.metric, v_value_text, v_rule.threshold::text, v_rule.period_days,
    v_rule.operator, v_rule.ledger_currency
  )
  returning * into v_alert;

  update public.automation_runs set alert_id = v_alert.id where id = v_run.id
  returning * into v_run;

  insert into public.audit_logs
    (business_id, actor_id, action, entity_type, entity_id, after_data)
  values (
    v_rule.business_id, v_actor, 'automation.alert.raised', 'alerts', v_alert.id,
    jsonb_build_object(
      'rule',      v_rule.name,
      'metric',    v_rule.metric,
      'operator',  v_rule.operator::text,
      'value',     v_value_text,
      'threshold', v_rule.threshold::text,
      'currency',  v_rule.ledger_currency
    )
  );

  return v_run;
end;
$$;

revoke all on function public.automation_evaluate_rule(uuid) from anon, public;
grant execute on function public.automation_evaluate_rule(uuid) to authenticated;
grant execute on function public.automation_evaluate_rule(uuid) to service_role;


-- ----------------------------------------------------------------------------
-- 4. Self-verification
-- ----------------------------------------------------------------------------

do $$
begin
  if (select count(*) from public.canonical_metrics where key like 'ledger\_%' and origin = 'computed') <> 9 then
    raise exception 'SELF-CHECK: expected 9 ledger metrics.';
  end if;
  if has_function_privilege('authenticated', 'public.automation_ledger_value(uuid, text, text, timestamptz, timestamptz, boolean)', 'EXECUTE') then
    raise exception 'SECURITY: automation_ledger_value must not be callable by signed-in users.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'automation_evaluate_rule'
      and position('automation_ledger_value' in p.prosrc) > 0
      and position('bm.user_id = v_actor' in p.prosrc) > 0
  ) then
    raise exception 'SELF-CHECK: the evaluator lost its ledger branch or its membership check.';
  end if;
  raise notice 'Migration 0041 verified: ledger alert metrics, per-currency rules, evaluator extended.';
end;
$$;

commit;
