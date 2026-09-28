-- ============================================================================
-- 0059  Fix: tax-document fee/VAT amounts must be negative, like every other
--       fee (migration 0057 recorded them as printed on the PDF: positive)
-- ============================================================================
-- Every fee and VAT amount BizMind already records -- from the settlement --
-- is stored negative: money the marketplace took. Migration 0057's tax
-- invoice and credit note reader took each amount exactly as the PDF prints
-- it, which is always a plain positive number (a document states "this much
-- VAT applies," it does not sign it debit/credit). Nothing negated it before
-- it reached the ledger. Found because the owner uploaded their real August
-- documents and asked to verify the total: the settlement's own SP 360 VAT
-- line is correctly -AED 116.44 (a cost), while the new tax-document VAT
-- lines were recorded as positive AED 177.51 -- two different sign
-- conventions for the same kind of fact, combining to a total (AED 61.07)
-- that happened to look plausible but was not built on a consistent basis.
--
-- `ledger_mapping_rules` cannot be edited (a trigger enforces it: only
-- ACTIVE -> RETIRED is permitted). This retires the 28 rules 0057 seeded and
-- replaces them with version-2 rules that are identical except
-- sign_rule = 'NEGATE'. A credit note's already-negative delta (a fee being
-- reduced) negates correctly too: "-32.93" becomes "32.93", partly reversing
-- the fee's negative total -- exactly the intended effect.
--
-- `classification_rules` is untouched: the category each line gets
-- (INFORMATIONAL / INPUT_VAT) was correct; only the stored amount's sign
-- was wrong.
--
-- THE LEDGER ITSELF DOES NOT GET REPAIRED HERE, AND CANNOT BE: financial_
-- transactions is immutable. Any tax invoice or credit note already
-- uploaded was written with the old (positive) sign and stays exactly as
-- uploaded until its source file is withdrawn and re-uploaded -- the
-- owner needs to do this for the four August documents once this migration
-- is live. See the message accompanying this file.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

update public.ledger_mapping_rules
set status = 'RETIRED'
where business_id is null
  and marketplace_code = 'AMAZON'
  and format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note')
  and status = 'ACTIVE';

insert into public.ledger_mapping_rules (
  scope, business_id, marketplace_code, format_id, match_key, match, side, category, subcategory,
  sign_rule, quantity_rule, attribution, confidence, evidence, version, supersedes_id, status
)
select 'GLOBAL', null, 'AMAZON', old.format_id, old.match_key, old.match, old.side, old.category, old.subcategory,
       'NEGATE', old.quantity_rule, old.attribution, old.confidence,
       old.evidence || ' Corrected 2026-09-28: the amount a tax document prints is a plain positive '
         || 'magnitude, never signed; negated here to match every other fee and VAT amount BizMind '
         || 'records as a cost (migration 0059).',
       old.version + 1, old.id, 'ACTIVE'
from public.ledger_mapping_rules old
where old.business_id is null
  and old.marketplace_code = 'AMAZON'
  and old.format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note')
  and old.status = 'RETIRED'
  and old.version = 1;

do $$
declare
  v_active_count integer;
  v_wrong_sign_count integer;
begin
  select count(*) into v_active_count from public.ledger_mapping_rules
  where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
    and format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note');
  if v_active_count <> 28 then
    raise exception 'SELF-CHECK: expected 28 active tax-document mapping rules after the fix, found %.', v_active_count;
  end if;

  select count(*) into v_wrong_sign_count from public.ledger_mapping_rules
  where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
    and format_id in ('amazon.tax_invoice', 'amazon.tax_credit_note')
    and sign_rule <> 'NEGATE';
  if v_wrong_sign_count <> 0 then
    raise exception 'SELF-CHECK: % active tax-document mapping rule(s) still do not negate.', v_wrong_sign_count;
  end if;

  if not exists (
    select 1 from public.ledger_mapping_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'RETIRED'
      and format_id = 'amazon.tax_invoice' and match_key = 'TaxInvoice|VAT|Sales Commission' and version = 1
  ) then
    raise exception 'SELF-CHECK: the old version-1 rule should be RETIRED, not gone.';
  end if;

  raise notice 'Migration 0059 verified: % tax-document mapping rules now negate their amount.', v_active_count;
end;
$$;

commit;
