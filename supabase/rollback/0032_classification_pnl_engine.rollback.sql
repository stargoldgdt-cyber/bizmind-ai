-- ============================================================================
-- Rollback for 0032  Automatic classification and the P&L engine
-- ============================================================================
-- Removes everything 0032 added. Ledger rows are untouched by 0032, so nothing
-- about recorded files changes. Refuses while any business has classified its
-- own marketplace codes, because that is owner-entered data.
-- ============================================================================

begin;

do $$
begin
  if exists (select 1 from public.classification_rules where scope = 'BUSINESS') then
    raise exception 'Refusing to roll back 0032: a business has classified its own marketplace codes.';
  end if;
end;
$$;

drop function if exists public.classification_rule_retire(uuid);
drop function if exists public.classification_rule_classify(uuid, text, text, text, text, text, text);
drop function if exists public.classification_rule_impact(uuid, text, text, text);
drop function if exists public.ledger_data_quality(timestamptz, timestamptz, uuid);
drop function if exists public.pnl_breakdown(timestamptz, timestamptz, uuid);
drop function if exists public.pnl_summary(timestamptz, timestamptz, uuid);
drop function if exists public.tax_profile_set_input_vat(uuid, text);
drop view if exists public.ledger_classified_lines;
drop table if exists public.classification_rules;
drop table if exists public.classification_categories;
drop function if exists public.classification_rule_guard();
drop function if exists public.classification_match_key(text, text, text);
alter table public.tax_profiles drop column if exists input_vat_treatment;

commit;
