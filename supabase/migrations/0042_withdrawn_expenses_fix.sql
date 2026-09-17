-- ============================================================================
-- 0042  Fix: withdrawn expenses no longer count
-- ============================================================================
-- GCC Phase 7 follow-up, found in the dashboard audit (2026-09-17).
--
-- Withdrawing an import (0027) does not delete its expenses: it marks them
-- withdrawn_at. The legacy analytics skip them; 0037's expense_lines view did
-- not, so operating expenses and Net Profit still counted expenses from an
-- import the owner had withdrawn.
--
-- Both definitions below are 0037's, with one condition added. Same columns
-- and signature, so every reader built on the view (expense_summary,
-- expense_breakdown, expense_periods, expense_category_queue, pnl_net_profit,
-- the ledger alerts) is corrected at once and keeps its privileges.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0041.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace view public.expense_lines
with (security_invoker = true)
as
select
  e.id,
  e.business_id,
  e.incurred_at,
  e.amount::text                                   as amount,
  (-e.amount)::numeric(20,4)::text                 as signed_amount,
  e.currency::text                                 as currency,
  e.category                                       as category_name,
  public.expense_category_key(e.category)          as match_key,
  r.id                                             as rule_id,
  case when r.id is null then null when r.business_id is null then 'GLOBAL' else 'BUSINESS' end as rule_scope,
  c.code                                           as category_code,
  c.label                                          as category_label,
  c.cost_class,
  case when r.id is null then 'UNCLASSIFIED' else 'CLASSIFIED' end as classification_status,
  e.description,
  e.vendor,
  e.external_id,
  e.source::text                                   as source
from public.expenses e
left join lateral (
  select cr.id, cr.business_id, cr.category_code
  from public.expense_category_rules cr
  where cr.status = 'ACTIVE'
    and cr.match_key = public.expense_category_key(e.category)
    and (cr.business_id is null or cr.business_id = e.business_id)
  -- The business's own word wins over BizMind's.
  order by (cr.business_id is null)
  limit 1
) r on true
left join public.expense_categories c on c.code = r.category_code
-- An expense whose import was withdrawn (0027) is kept for the record but no
-- longer counts anywhere.
where e.withdrawn_at is null;

create or replace function public.expense_category_classify(
  p_business_id   uuid,
  p_category_name text,
  p_category_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      text := public.expense_category_key(p_category_name);
  v_previous public.expense_category_rules;
  v_id       uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can classify expenses.' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'Expenses with no category cannot be classified together. Give them a category first.'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.expense_categories c where c.code = p_category_code) then
    raise exception 'Choose one of BizMind''s expense categories.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.expenses e
    where e.business_id = p_business_id and public.expense_category_key(e.category) = v_key
      and e.withdrawn_at is null
  ) then
    raise exception 'No expense in this business uses that category.' using errcode = 'P0002';
  end if;

  select * into v_previous
  from public.expense_category_rules r
  where r.business_id = p_business_id and r.match_key = v_key and r.status = 'ACTIVE';

  if v_previous.id is not null then
    update public.expense_category_rules
    set status = 'RETIRED', retired_by = (select auth.uid()), retired_at = now()
    where id = v_previous.id;
  end if;

  insert into public.expense_category_rules (business_id, match_key, category_code, created_by)
  values (p_business_id, v_key, p_category_code, (select auth.uid()))
  returning id into v_id;

  perform public.write_audit_log(
    p_business_id, 'expense_category.classified', 'expense_category_rules', v_id,
    case when v_previous.id is null then null
         else jsonb_build_object('category_code', v_previous.category_code, 'rule_id', v_previous.id) end,
    jsonb_build_object('category_name', left(p_category_name, 120), 'match_key', v_key, 'category_code', p_category_code)
  );
  return v_id;
end;
$$;

do $$
begin
  if position('withdrawn_at is null' in lower(pg_get_viewdef('public.expense_lines'::regclass))) = 0 then
    raise exception 'Migration 0042 failed: expense_lines still counts withdrawn expenses.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'expense_lines'
      and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) or has_table_privilege('anon', 'public.expense_lines', 'SELECT') then
    raise exception 'SECURITY: expense_lines must stay an invoker view anon cannot read.';
  end if;
  raise notice 'Migration 0042 verified: withdrawn expenses no longer count.';
end;
$$;

commit;
