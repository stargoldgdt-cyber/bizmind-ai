-- ============================================================================
-- 0017  An alert records HOW it was compared, not just what to
-- ============================================================================
-- Migration 0016 copied the metric, value, threshold and period onto every
-- alert so it could be read months later without depending on a rule that may
-- since have changed. It did not copy the OPERATOR, and that turns out to
-- matter for more than completeness.
--
-- A CHANGE_PCT alert on revenue stores a metric_value that is a PERCENTAGE.
-- A value alert on revenue stores MONEY. Both say metric = 'revenue', and
-- nothing else on the row tells them apart -- so the display layer was left
-- guessing at the wording of the alert text to decide whether to print a
-- currency symbol.
--
-- Formatting a 20% fall as "$-20.00" is exactly the class of plausible-wrong
-- number this product exists not to produce. The row was missing a fact, so
-- the fix is to store the fact.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The column
-- ----------------------------------------------------------------------------
-- Added nullable and backfilled rather than declared NOT NULL outright. There
-- should be no alerts yet, but a migration that assumes the table is empty is
-- a migration that fails on the one database where it is not.

alter table public.alerts
  add column operator public.automation_operator;

update public.alerts a
set operator = r.operator
from public.automation_rules r
where a.rule_id = r.id and a.operator is null;

-- Anything still unset fired on a rule that has since been deleted. A value
-- comparison is the safe assumption: it formats the figure in the metric's own
-- units, which is what an alert with no percentage in it should show.
update public.alerts set operator = 'GTE' where operator is null;

alter table public.alerts alter column operator set not null;

comment on column public.alerts.operator is
  'How the comparison was made. Read by the display layer to know whether '
  'metric_value is a percentage change or a figure in the metric own units.';


-- ----------------------------------------------------------------------------
-- 2. Record it when an alert is raised
-- ----------------------------------------------------------------------------
-- Identical to 0016 apart from the two lines that write the operator. Restated
-- in full rather than patched, so this file is the whole current definition.

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

  if not v_rule.enabled then
    v_skipped := 'DISABLED';
  elsif v_key is null then
    v_skipped := 'NO_ANALYTICS_KEY';
  elsif v_is_change and v_key not in (
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

  if v_skipped is null then
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
    metric, metric_value, threshold, period_days, operator
  )
  values (
    v_rule.business_id, v_rule.id, v_run.id, v_rule.severity,
    v_rule.name,
    case when v_is_change then
      format(
        '%s changed by %s%% over the last %s days compared with the %s before, '
        'which is %s %s%%.',
        v_rule.metric, v_value_text, v_rule.period_days::text,
        v_rule.period_days::text, v_direction, v_rule.threshold::text
      )
    else
      format(
        '%s over the last %s days is %s, which is %s %s.',
        v_rule.metric, v_rule.period_days::text, v_value_text,
        v_direction, v_rule.threshold::text
      )
    end,
    v_rule.metric, v_value_text, v_rule.threshold::text, v_rule.period_days,
    v_rule.operator
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
      'threshold', v_rule.threshold::text
    )
  );

  return v_run;
end;
$$;

-- CREATE OR REPLACE keeps existing grants, but they are reissued rather than
-- assumed. Migration 0011 learned that a dropped function loses them silently.
revoke all on function public.automation_evaluate_rule(uuid) from anon, public;
grant execute on function public.automation_evaluate_rule(uuid) to authenticated;
grant execute on function public.automation_evaluate_rule(uuid) to service_role;


-- ----------------------------------------------------------------------------
-- 3. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_nullable text;
begin
  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = 'alerts'
    and column_name = 'operator';

  if v_nullable is null then
    raise exception 'alerts.operator was not created';
  end if;

  if v_nullable <> 'NO' then
    raise exception
      'alerts.operator is nullable, so an alert could still be displayed '
      'without knowing whether its value is a percentage or a figure.';
  end if;

  if has_function_privilege(
       'anon', 'public.automation_evaluate_rule(uuid)', 'EXECUTE') then
    raise exception 'SECURITY: anon can execute automation_evaluate_rule';
  end if;

  raise notice
    'Migration 0017 verified: every alert now records how it was compared.';
end;
$$;


commit;
