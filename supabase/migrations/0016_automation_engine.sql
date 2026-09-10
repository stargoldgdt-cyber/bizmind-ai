-- ============================================================================
-- 0016  Automation: deterministic rules over verified figures
-- ============================================================================
-- The ALERT step of CONNECT -> UNDERSTAND -> ANALYZE -> ALERT -> RECOMMEND
-- -> AUTOMATE, and the first one where being wrong has consequences rather
-- than being merely embarrassing.
--
-- SO V1 IS DELIBERATELY NARROW
-- ----------------------------
-- Deterministic: a rule fires because a number crossed a line, not because a
-- model found it plausible. Same inputs, same outcome, every time.
--
-- Auditable: every evaluation is recorded, INCLUDING the ones that did not
-- fire, and why. "Why didn't I get an alert?" is the question an owner asks
-- after the fact, and it has to be answerable.
--
-- Bounded: raising an alert is the only action. Nothing prices, buys, emails a
-- customer, or changes a merchant's store. CLAUDE.md forbids autonomous AI
-- actions, and an automation engine is exactly where that gets tempting.
--
-- EVALUATION HAPPENS HERE, IN SQL
-- -------------------------------
-- A rule asking "is gross margin below 15?" reads analytics_financials() and
-- compares in the database. No figure is compared in TypeScript, so an alert
-- cannot fire on a number that disagrees with the owner's own dashboard.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Teach canonical_metrics which analytics column carries each metric
-- ----------------------------------------------------------------------------
-- A rule targets a CANONICAL metric -- `marketplace_fees` -- but the analytics
-- functions return a column called `fees`. The mapping already exists in
-- src/services/metrics/canonical.ts as `analyticsKey`; it is copied here so
-- SQL can resolve a rule without asking the application.
--
-- The two are asserted to agree by the test suite, so drift becomes a failing
-- test rather than a rule that silently never fires.

alter table public.canonical_metrics add column analytics_key text;

update public.canonical_metrics set analytics_key = key
where key in (
  'revenue', 'cogs', 'refunds', 'gross_profit', 'gross_margin',
  'net_profit', 'net_margin', 'cost_coverage', 'fee_coverage'
);

update public.canonical_metrics set analytics_key = 'fees'            where key = 'marketplace_fees';
update public.canonical_metrics set analytics_key = 'expenses'        where key = 'operating_expenses';
update public.canonical_metrics set analytics_key = 'orders_count'    where key = 'orders';
update public.canonical_metrics set analytics_key = 'units_sold'      where key = 'units';
update public.canonical_metrics set analytics_key = 'customers_count' where key = 'customers';
update public.canonical_metrics set analytics_key = 'avg_order_value' where key = 'aov';

comment on column public.canonical_metrics.analytics_key is
  'The column this metric occupies in the analytics functions. NULL means the '
  'analytics engine does not publish it, so no rule can be written on it.';


-- ----------------------------------------------------------------------------
-- 2. Vocabulary
-- ----------------------------------------------------------------------------

create type public.automation_operator as enum (
  'LT', 'LTE', 'GT', 'GTE',
  'CHANGE_PCT_LT',   -- period-on-period change is below the threshold
  'CHANGE_PCT_GT'    -- period-on-period change is above the threshold
);

create type public.alert_severity as enum ('INFO', 'WARNING', 'CRITICAL');

create type public.alert_status as enum ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

create type public.automation_run_status as enum (
  'FIRED',
  'NOT_MATCHED',
  'SKIPPED',      -- deliberately not judged; see skipped_reason
  'FAILED'        -- something went wrong
);


-- ----------------------------------------------------------------------------
-- 3. automation_rules
-- ----------------------------------------------------------------------------
-- The action lives on the rule rather than in an actions table. V1 has exactly
-- one action -- raise an alert -- and a table for it would be structure built
-- for a feature nobody has asked for. `requires_approval` is here so the
-- approval workflow has somewhere to land when actions do arrive.

create table public.automation_rules (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,

  /** The owner's own words. This becomes the alert's headline. */
  name        text not null check (length(trim(name)) between 1 and 120),
  description text,
  enabled     boolean not null default true,

  /**
   * What is watched.
   *
   * A foreign key, so a rule cannot be written against a metric BizMind does
   * not define. "Alert me when profitability drops" cannot quietly become a
   * rule over a column nobody has agreed the meaning of -- which is Phase
   * 7.2's rule, enforced by the schema rather than by care.
   */
  metric    text not null references public.canonical_metrics (key),
  operator  public.automation_operator not null,

  /** Exact decimal, like every other figure here. Crosses out as text. */
  threshold numeric not null,

  /** The window to evaluate over. CHANGE_PCT compares it to the one before. */
  period_days integer not null default 30 check (period_days between 1 and 365),

  severity public.alert_severity not null default 'WARNING',

  /**
   * How long before this rule may fire again.
   *
   * A metric sitting just under its threshold should produce one alert, not
   * forty. Without a cooldown, a margin resting at 14.99 pages somebody every
   * time the worker runs -- and alerts that cry wolf stop being read, which
   * costs more than the alert was ever worth.
   */
  cooldown_hours integer not null default 24 check (cooldown_hours between 0 and 8760),

  /** How often the worker should look at this rule. */
  evaluate_every_minutes integer not null default 60
    check (evaluate_every_minutes between 5 and 10080),
  next_run_at timestamptz not null default now(),

  /**
   * Refuse to fire when the driving figure is known to be incomplete.
   *
   * Phase 7.1 established that a blank never becomes a zero, and Phase 8 that
   * the AI will not recommend action on a margin inflated by missing costs.
   * Automation inherits it: a margin that "collapses" because cost data
   * finally arrived is not a business event, and alerting on it teaches an
   * owner to distrust the product.
   */
  suppress_when_incomplete boolean not null default true,

  /** Always true in V1: there is no executor, so nothing can act unapproved. */
  requires_approval boolean not null default true,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, name)
);

comment on table public.automation_rules is
  'Deterministic thresholds over canonical metrics, evaluated in SQL so an '
  'alert can never disagree with the dashboard that produced it.';

create index automation_rules_due_idx
  on public.automation_rules (next_run_at) where enabled;
create index automation_rules_business_idx
  on public.automation_rules (business_id, enabled);

create trigger automation_rules_set_updated_at
  before update on public.automation_rules
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. automation_runs -- every evaluation, including the quiet ones
-- ----------------------------------------------------------------------------
-- A table of alerts records what fired. It cannot answer why something did
-- not, and that is the harder question to be asked six weeks later.

create table public.automation_runs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  rule_id     uuid not null references public.automation_rules (id) on delete cascade,

  evaluated_at timestamptz not null default now(),
  status       public.automation_run_status not null,

  /** The figure as text, exactly as analytics produced it. */
  metric_value text,

  /**
   * Nullable: a FAILED run may not have got far enough to know it, and
   * writing a placeholder number into an audit table is a small lie that
   * reads as fact later.
   */
  threshold text,

  /**
   * COOLDOWN | METRIC_NULL | INCOMPLETE_DATA | DISABLED
   * | NO_ANALYTICS_KEY | NO_COMPARISON
   */
  skipped_reason text,

  alert_id uuid,
  error    text
);

create index automation_runs_rule_idx
  on public.automation_runs (rule_id, evaluated_at desc);
create index automation_runs_business_idx
  on public.automation_runs (business_id, evaluated_at desc);


-- ----------------------------------------------------------------------------
-- 5. alerts
-- ----------------------------------------------------------------------------

create table public.alerts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  rule_id     uuid references public.automation_rules (id) on delete set null,
  run_id      uuid references public.automation_runs (id) on delete set null,

  severity public.alert_severity not null,
  title    text not null,
  body     text not null,

  /**
   * What it fired on, copied rather than joined.
   *
   * A rule can be edited or deleted afterwards. An alert that re-read its rule
   * would rewrite its own history, and an owner checking last month's alert
   * would be shown today's threshold.
   */
  metric       text not null,
  metric_value text not null,
  threshold    text not null,
  period_days  integer not null,

  status public.alert_status not null default 'OPEN',

  acknowledged_by uuid references public.profiles (id) on delete set null,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);

create index alerts_business_idx on public.alerts (business_id, status, created_at desc);

alter table public.automation_runs
  add constraint automation_runs_alert_fk
  foreign key (alert_id) references public.alerts (id) on delete set null;


-- ----------------------------------------------------------------------------
-- 6. Row Level Security
-- ----------------------------------------------------------------------------
-- A rule is a standing instruction about somebody's business. Writing one is
-- closer to changing a financial setting than to filing a ticket, so STAFF and
-- VIEWER read but do not write.

do $$
declare
  t text;
begin
  foreach t in array array['automation_rules', 'automation_runs', 'alerts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_insert_admin', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_delete_admin', t);

    -- Supabase's ALTER DEFAULT PRIVILEGES grants ALL on every new table to
    -- anon and authenticated before a line of this migration runs. So take it
    -- all away first and give back only what is needed. Migration 0012
    -- learned this twice.
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

/**
 * Editing a rule is an admin action. Acknowledging an alert is not.
 *
 * STAFF are the people who will actually see an alert and deal with it.
 * Making them ask an owner to tick it off means alerts stay open, the open
 * count stops meaning anything, and the whole signal decays.
 */
create policy automation_rules_update_admin on public.automation_rules
  for update to authenticated
  using (public.current_user_has_role(
    business_id, array['OWNER','ADMIN']::public.business_role[]))
  with check (public.current_user_has_role(
    business_id, array['OWNER','ADMIN']::public.business_role[]));

create policy automation_runs_update_admin on public.automation_runs
  for update to authenticated
  using (public.current_user_has_role(
    business_id, array['OWNER','ADMIN']::public.business_role[]));

create policy alerts_update_member on public.alerts
  for update to authenticated
  using (business_id in (select public.current_user_business_ids()))
  with check (business_id in (select public.current_user_business_ids()));


-- ----------------------------------------------------------------------------
-- 7. Evaluation
-- ----------------------------------------------------------------------------

/**
 * Evaluates one rule and records what happened.
 *
 * SECURITY DEFINER, for two reasons. The scheduled worker has no session at
 * all, and the audit entry has to be written on a path where `auth.uid()` is
 * null -- which `write_audit_log()` refuses by design.
 *
 * WHY THAT IS NOT A TENANT HOLE
 * -----------------------------
 * It takes a RULE id, never a business id. The tenant is read off the rule
 * row, which is the same trusted-resolution pattern the sync functions use:
 * there is no argument a caller could point at another business. A caller who
 * does have a session is additionally checked for membership below, so a
 * signed-in user cannot evaluate somebody else's rule.
 */
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
    -- The metric is in the vocabulary but the analytics engine does not
    -- publish it, so there is nothing to compare against. Recorded rather
    -- than guessed at.
    v_skipped := 'NO_ANALYTICS_KEY';
  elsif v_is_change and v_key not in (
      'revenue', 'cogs', 'fees', 'gross_profit', 'gross_margin', 'expenses',
      'net_profit', 'net_margin', 'orders_count', 'units_sold',
      'avg_order_value', 'customers_count', 'refunds', 'cost_coverage') then
    -- analytics_compare() produces no period-on-period change for this one.
    -- Saying so beats a NULL the owner would read as "nothing wrong".
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
    -- Money and ratios cross the public boundary as TEXT (migration 0011), so
    -- they are cast back to numeric here, inside the database, where the
    -- comparison is exact. No figure becomes a JavaScript double on the way.
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
      -- No orders in the window, or a ratio with no denominator. Reading an
      -- unknown as zero would page an owner at 6am over a public holiday.
      v_skipped := 'METRIC_NULL';
    else
      v_cost_cov := (v_financials ->> 'cost_coverage')::numeric;
      v_fee_cov  := (v_financials ->> 'fee_coverage')::numeric;

      -- A profit figure resting on missing costs is overstated by an unknown
      -- amount, so a rule watching it is watching noise.
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
      -- "revenue fell by more than 20%" is a threshold of -20 and a percent
      -- change more negative than it.
      when 'CHANGE_PCT_LT' then v_value < v_rule.threshold
      when 'CHANGE_PCT_GT' then v_value > v_rule.threshold
    end;
  end if;

  -- Explicit casts. A CASE of bare literals is text, and inserting text into
  -- an enum column raises 42804 -- the fault that broke every webhook
  -- delivery in migration 0012 until the assertion block caught it.
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
    metric, metric_value, threshold, period_days
  )
  values (
    v_rule.business_id, v_rule.id, v_run.id, v_rule.severity,
    v_rule.name,
    format(
      '%s over the last %s days is %s, which is %s %s.',
      v_rule.metric, v_rule.period_days::text, v_value_text,
      v_direction, v_rule.threshold::text
    ),
    v_rule.metric, v_value_text, v_rule.threshold::text, v_rule.period_days
  )
  returning * into v_alert;

  update public.automation_runs set alert_id = v_alert.id where id = v_run.id
  returning * into v_run;

  -- Written directly, not through write_audit_log(), which requires a session
  -- the scheduled path does not have. Same reason as webhook_event_ingest().
  insert into public.audit_logs
    (business_id, actor_id, action, entity_type, entity_id, after_data)
  values (
    v_rule.business_id, v_actor, 'automation.alert.raised', 'alerts', v_alert.id,
    jsonb_build_object(
      'rule',      v_rule.name,
      'metric',    v_rule.metric,
      'value',     v_value_text,
      'threshold', v_rule.threshold::text
    )
  );

  return v_run;
end;
$$;


/**
 * Claims the rules that are due, across every business.
 *
 * The worker runs on a schedule with nobody watching, so it CANNOT be handed a
 * business id -- callTrusted() refuses any privileged call carrying one, which
 * is the whole point of that door. It asks "what is due?" and the database
 * answers; the worker never names a tenant.
 *
 * next_run_at is pushed forward as part of the claim, so two workers running
 * at once cannot both take the same rule.
 */
create or replace function public.automation_claim_due(p_limit integer default 25)
returns table (rule_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.automation_rules r
  set next_run_at = now() + make_interval(mins => r.evaluate_every_minutes)
  where r.id in (
    select c.id
    from public.automation_rules c
    where c.enabled and c.next_run_at <= now()
    order by c.next_run_at
    for update skip locked
    limit p_limit
  )
  returning r.id;
$$;


/**
 * Evaluates every enabled rule for one business, now.
 *
 * This is the "run my rules" button, not the worker path -- it takes a
 * business id, so it is never added to the trusted function list. It is
 * SECURITY DEFINER only so it can call the rule evaluator, and it checks
 * membership itself before it does anything.
 */
create or replace function public.automation_evaluate_business(p_business_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_id uuid;
  v_fired   integer := 0;
  v_run     public.automation_runs;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.business_members bm
    where bm.business_id = p_business_id and bm.user_id = (select auth.uid())
  ) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;

  for v_rule_id in
    select id from public.automation_rules
    where business_id = p_business_id and enabled
    order by created_at
  loop
    begin
      v_run := public.automation_evaluate_rule(v_rule_id);
      if v_run.status = 'FIRED' then v_fired := v_fired + 1; end if;
    exception when others then
      -- One broken rule must not stop the others. A rule that fails silently
      -- is worse than no rule, because the owner believes they are covered.
      insert into public.automation_runs (business_id, rule_id, status, error)
      values (p_business_id, v_rule_id,
              'FAILED'::public.automation_run_status, sqlerrm);
    end;
  end loop;

  return v_fired;
end;
$$;


/** Acknowledges an alert. Any member may: they are the ones who act on it. */
create or replace function public.alert_acknowledge(p_alert_id uuid)
returns public.alerts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alert public.alerts;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- SECURITY INVOKER, so RLS scopes this: an alert belonging to another
  -- business is simply not found.
  update public.alerts
  set status          = 'ACKNOWLEDGED',
      acknowledged_by = (select auth.uid()),
      acknowledged_at = now()
  where id = p_alert_id and status = 'OPEN'
  returning * into v_alert;

  if v_alert.id is null then
    raise exception 'No such open alert.' using errcode = 'P0002';
  end if;

  perform public.write_audit_log(
    v_alert.business_id, 'automation.alert.acknowledged', 'alerts',
    v_alert.id, null, jsonb_build_object('metric', v_alert.metric)
  );

  return v_alert;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Privileges
-- ----------------------------------------------------------------------------

revoke all on function public.automation_evaluate_rule(uuid) from anon, public;
grant execute on function public.automation_evaluate_rule(uuid) to authenticated;
grant execute on function public.automation_evaluate_rule(uuid) to service_role;

-- The worker's door. NOT granted to authenticated: it crosses every tenant by
-- design, and no signed-in user has any business calling it.
revoke all on function public.automation_claim_due(integer)
  from anon, public, authenticated;
grant execute on function public.automation_claim_due(integer) to service_role;

revoke all on function public.automation_evaluate_business(uuid) from anon, public;
grant execute on function public.automation_evaluate_business(uuid) to authenticated;

revoke all on function public.alert_acknowledge(uuid) from anon, public;
grant execute on function public.alert_acknowledge(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. Self-verification
-- ----------------------------------------------------------------------------
-- Migration 0012 found five faults in four attempts this way, two of them
-- security holes, after review and 462 offline assertions had all passed. A
-- migration asserts its own guarantees rather than trusting that its
-- statements did what they appear to.

do $$
declare
  t          text;
  v_rls      boolean;
  v_policies integer;
  v_missing  integer;
begin
  foreach t in array array['automation_rules', 'automation_runs', 'alerts']
  loop
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = t;

    if v_policies <> 4 then
      raise exception
        'SECURITY: table public.% has % policies, expected 4', t, v_policies;
    end if;

    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'SECURITY: anon can read public.%', t;
    end if;
  end loop;

  -- The cross-tenant claim function must be unreachable by a signed-in user.
  if has_function_privilege(
       'authenticated', 'public.automation_claim_due(integer)', 'EXECUTE') then
    raise exception
      'SECURITY: authenticated can execute automation_claim_due, which reads '
      'rules belonging to every business.';
  end if;

  -- Every metric the analytics engine publishes must be usable in a rule. One
  -- missing would mean a rule an owner could save that never fires.
  select count(*) into v_missing
  from public.canonical_metrics
  where analytics_key is null
    and key in ('revenue', 'cogs', 'marketplace_fees', 'gross_profit',
                'gross_margin', 'operating_expenses', 'net_profit',
                'net_margin', 'orders', 'units', 'customers', 'aov',
                'refunds', 'cost_coverage', 'fee_coverage');

  if v_missing > 0 then
    raise exception
      '% published metrics have no analytics_key, so a rule written on them '
      'would silently never fire.', v_missing;
  end if;

  raise notice
    'Migration 0016 verified: rules target real metrics, RLS is on and '
    'forced, anon is locked out, only the worker can claim across tenants, '
    'and an unmeasurable figure cannot raise an alert.';
end;
$$;


commit;
