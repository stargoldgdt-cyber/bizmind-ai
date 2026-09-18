-- ============================================================================
-- 0044  Amazon: "Paid Services Fee" (the SP 360 fee, VAT included)
-- ============================================================================
-- Found in the owner's first real upload after GCC Phase 9. Newer Amazon.ae
-- settlements report the Selling Partner 360 fee as ONE line:
--
--   other-transaction | other-transaction | Paid Services Fee
--
-- where earlier settlements had two ("AmazonFees | Premium Services Fee |
-- Base fee" and "... | Tax on fee"). The owner's Amazon tax invoice shows the
-- single line is the fee WITH its 5% VAT inside it (fee + VAT = the line).
--
-- WHAT CHANGES
--   1. One GLOBAL import rule: a marketplace-level marketplace fee
--      (premium_services), as reported.
--   2. One GLOBAL classification rule: Marketplace fee, "SP 360 premium
--      services", amount_includes_vat = true (owner decision, 2026-09-18).
--      As with noon's fees (0034), the P&L engine then marks contribution
--      FEE_VAT_NOT_SEPARATED while the account's VAT on fees is Recoverable,
--      and counts the whole line as the fee when it is Non-recoverable.
--
-- Nothing else changes. Lines already uploaded are classified by the new rule
-- the next time figures are calculated; no ledger row is touched and nothing
-- needs uploading again. Depends on 0031, 0032, 0034.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

insert into public.ledger_mapping_rules (
  scope, business_id, marketplace_code, format_id, match_key, match, side, category, subcategory,
  sign_rule, quantity_rule, attribution, confidence, evidence, version, status
)
select 'GLOBAL', null, 'AMAZON', 'amazon.settlement.flat_file_v2', r.match_key, r.match, r.side, r.category,
       r.subcategory, 'AS_REPORTED', r.quantity_rule, r.attribution, 'SAMPLE_VERIFIED', r.evidence, 1, 'ACTIVE'
from (values
  ('other-transaction|other-transaction|Paid Services Fee', '{"transaction-type": "other-transaction", "amount-type": "other-transaction", "amount-description": "Paid Services Fee"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'premium_services', 'NONE', 'MARKETPLACE', 'Seen in the owner''s real Amazon.ae settlement (February 2026) and matched to the owner''s Amazon tax invoice: fee 2325.86 + VAT 116.29 = the line. Owner decision 2026-09-18. Amazon Selling Partner 360 (SP 360) service fee reported on one line, VAT included. A marketplace fee, not advertising.')
) as r (match_key, match, side, category, subcategory, quantity_rule, attribution, evidence)
where not exists (
  select 1 from public.ledger_mapping_rules existing
  where existing.business_id is null
    and existing.marketplace_code = 'AMAZON'
    and existing.format_id = 'amazon.settlement.flat_file_v2'
    and existing.match_key = r.match_key
);

insert into public.classification_rules (
  scope, business_id, marketplace_code, format_id, match_key, category, subcategory, confidence,
  amount_includes_vat, separates_included_vat, evidence
)
select 'GLOBAL', null, 'AMAZON', 'amazon.settlement.flat_file_v2', r.match_key, r.category, r.subcategory, 'HIGH',
       true, false,
       'Owner decision (2026-09-18), matched to the owner''s Amazon tax invoice. ' || r.note
from (values
  ('other-transaction|other-transaction|Paid Services Fee', 'MARKETPLACE_FEE', 'SP 360 premium services', 'Selling Partner 360 service fee on one line, 5% VAT included.')
) as r (match_key, category, subcategory, note)
where not exists (
  select 1 from public.classification_rules existing
  where existing.business_id is null
    and existing.marketplace_code = 'AMAZON'
    and existing.format_id = 'amazon.settlement.flat_file_v2'
    and existing.match_key = r.match_key
    and existing.status = 'ACTIVE'
);

do $$
begin
  if not exists (
    select 1 from public.classification_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and match_key = 'other-transaction|other-transaction|Paid Services Fee'
      and category = 'MARKETPLACE_FEE' and amount_includes_vat and not separates_included_vat
  ) or not exists (
    select 1 from public.ledger_mapping_rules
    where business_id is null and marketplace_code = 'AMAZON' and status = 'ACTIVE'
      and match_key = 'other-transaction|other-transaction|Paid Services Fee'
      and side = 'PNL' and category = 'MARKETPLACE_FEE' and attribution = 'MARKETPLACE'
  ) then
    raise exception 'SELF-CHECK: the Paid Services Fee rules are missing or wrong.';
  end if;
  raise notice 'Migration 0044 verified: Paid Services Fee is the SP 360 fee, VAT included.';
end;
$$;

commit;
