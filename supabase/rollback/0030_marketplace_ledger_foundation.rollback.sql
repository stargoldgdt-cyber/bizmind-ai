-- ============================================================================
-- ROLLBACK for 0030  The marketplace ledger foundation
-- ============================================================================
-- NOT a migration. Kept outside supabase/migrations so no tool applies it by
-- accident. Run it by hand in the Supabase SQL editor only to undo 0030.
--
-- It REFUSES to run while any ledger file or marketplace account exists:
-- rolling back must never be a way to delete financial records. Delete the
-- test businesses (or withdraw nothing -- delete them) first.
--
-- What it cannot undo: 0029's enum value `import_entity = 'LEDGER'`.
-- PostgreSQL cannot remove an enum value. Unused, it is harmless.
-- ============================================================================

begin;

do $$
begin
  if exists (select 1 from public.import_batches where dataset <> 'LEGACY')
     or exists (select 1 from public.marketplace_accounts) then
    raise exception
      'Rollback refused: ledger files or marketplace accounts exist. Nothing has been removed.';
  end if;
end;
$$;

drop view if exists public.ledger_payouts;
drop view if exists public.ledger_settlements;
drop view if exists public.ledger_lines;

drop function if exists public.ledger_file_restore(uuid);
drop function if exists public.ledger_file_withdraw(uuid, text);
drop function if exists public.ledger_apply_file(jsonb);
drop function if exists public.tax_profile_update(uuid, text, text);
drop function if exists public.marketplace_account_update(uuid, text, text, text, text);
drop function if exists public.marketplace_account_create(uuid, text, text, text, text, text);

drop trigger if exists import_issues_ledger_guard on public.import_issues;
drop trigger if exists import_batches_ledger_guard on public.import_batches;

drop table if exists public.financial_transactions;
drop table if exists public.payouts;
drop table if exists public.settlements;
drop table if exists public.source_rows;
drop table if exists public.ledger_mapping_rules;
drop table if exists public.tax_profiles;

drop index if exists public.import_batches_ledger_file_once;
drop index if exists public.import_batches_marketplace_account_idx;

alter table public.import_batches
  drop constraint if exists import_batches_ledger_identity_check,
  drop constraint if exists import_batches_marketplace_account_fkey,
  drop constraint if exists import_batches_business_id_id_key,
  drop column if exists stripped_columns,
  drop column if exists file_sha256,
  drop column if exists adapter_version,
  drop column if exists format_id,
  drop column if exists marketplace_account_id,
  drop column if exists source_kind,
  drop column if exists dataset;

drop table if exists public.marketplace_accounts;
drop table if exists public.marketplaces;

drop function if exists public.import_issue_ledger_guard();
drop function if exists public.import_batch_ledger_guard();
drop function if exists public.ledger_mapping_rule_guard();
drop function if exists public.marketplace_account_guard();
drop function if exists public.payout_guard();
drop function if exists public.ledger_truncate_guard();
drop function if exists public.ledger_immutable_guard();
drop function if exists public.ledger_json_is_optional_text(jsonb, integer);
drop function if exists public.ledger_json_is_absent(jsonb);
drop function if exists public.ledger_json_is_instant(jsonb);
drop function if exists public.ledger_json_is_money(jsonb);
drop function if exists public.ledger_category_valid(text, text);
drop function if exists public.ledger_raw_is_clean(jsonb);
drop function if exists public.ledger_text_has_email(text);
drop function if exists public.ledger_is_customer_column(text);
drop function if exists public.ledger_writer_active();

commit;
