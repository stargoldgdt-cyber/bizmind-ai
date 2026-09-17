-- ============================================================================
-- 0034  noon: Transaction View + Invoices and Credit Notes
-- ============================================================================
-- GCC Phase 5. Built from the owner's real July 2026 noon exports.
--
-- WHAT CHANGES
--   1. classification_rules gains two flags:
--        amount_includes_vat      the amount has VAT inside it (noon fees)
--        separates_included_vat   the line takes that VAT back out (invoices)
--   2. 61 noon rules, as import rules and as classification rules,
--      generated from src/services/marketplaces/noon/rules.ts.
--   3. marketplaces.NOON becomes AVAILABLE.
--   4. Overlapping exports: ledger_apply_file() refuses a file that repeats a
--      row already counted for the account, and ledger_file_restore() refuses
--      to restore a file whose rows are counted elsewhere. (Otherwise copied
--      verbatim from 0031 / 0030.)
--   5. ledger_classified_lines exposes the two flags.
--   6. pnl_summary() is recreated: an optional business filter, an optional
--      "all accounts in one currency" total, and a new incomplete reason,
--      FEE_VAT_NOT_SEPARATED: fees that include VAT with no invoice separating
--      it in the period, unless the account's VAT setting is Non-recoverable
--      (then fees including VAT are the right cost).
--   7. ledger_data_quality() is recreated with the same new item, per month.
--
-- Ledger rows are not touched. Depends on 0030-0033.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. VAT flags on classification rules
-- ----------------------------------------------------------------------------

alter table public.classification_rules
  add column amount_includes_vat boolean not null default false,
  add column separates_included_vat boolean not null default false;

alter table public.classification_rules
  add constraint classification_rules_vat_flags_check
  check (not (amount_includes_vat and separates_included_vat));

comment on column public.classification_rules.amount_includes_vat is
  'The line''s amount has VAT inside it that the marketplace does not state on the line.';
comment on column public.classification_rules.separates_included_vat is
  'The line takes stated VAT back out of amounts that included it (a VAT invoice).';


-- ----------------------------------------------------------------------------
-- 2. noon rules
-- ----------------------------------------------------------------------------

insert into public.ledger_mapping_rules (
  scope, business_id, marketplace_code, format_id, match_key, match, side, category, subcategory,
  sign_rule, quantity_rule, attribution, confidence, evidence, version, status
)
select 'GLOBAL', null, 'NOON', r.format_id, r.match_key, jsonb_build_object('key', r.match_key),
       r.side, r.category, r.subcategory, 'AS_REPORTED', r.quantity_rule, r.attribution,
       'SAMPLE_VERIFIED', r.evidence, 1, 'ACTIVE'
from (values
  ('noon.transaction_view.item_level', 'order|Net Proceeds|item', 'PNL', 'REVENUE', 'net_proceeds', 'COUNT_LINE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). What the buyer paid for the item, as noon reports it.'),
  ('noon.transaction_view.item_level', 'order|Referral Fee including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'referral_fee', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Fullfilment & Logistics Fees including VAT|item', 'PNL', 'FULFILMENT', 'fulfilment_logistics', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Shipping Credits including VAT|item', 'PNL', 'REVENUE', 'shipping_credits', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Other Order Fees including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'other_order_fees', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order|Order Subsidies including VAT|item', 'PNL', 'SUBSIDY', 'order_subsidies', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Fees including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'non_order_fees', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Subsidies including VAT|item', 'PNL', 'SUBSIDY', 'non_order_subsidies', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order|Net Proceeds|order', 'PNL', 'REVENUE', 'net_proceeds', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). What the buyer paid for the item, as noon reports it.'),
  ('noon.transaction_view.item_level', 'order|Referral Fee including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'referral_fee', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Fullfilment & Logistics Fees including VAT|order', 'PNL', 'FULFILMENT', 'fulfilment_logistics', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Shipping Credits including VAT|order', 'PNL', 'REVENUE', 'shipping_credits', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Other Order Fees including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'other_order_fees', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order|Order Subsidies including VAT|order', 'PNL', 'SUBSIDY', 'order_subsidies', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Fees including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'non_order_fees', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Subsidies including VAT|order', 'PNL', 'SUBSIDY', 'non_order_subsidies', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order_update|Net Proceeds|item', 'PNL', 'REVENUE', 'net_proceeds_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Returns and later changes to an order; the sign shows the direction. Counted with sales, under review.'),
  ('noon.transaction_view.item_level', 'order_update|Referral Fee including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'referral_fee_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Fullfilment & Logistics Fees including VAT|item', 'PNL', 'FULFILMENT', 'fulfilment_logistics_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Shipping Credits including VAT|item', 'PNL', 'REVENUE', 'shipping_credits_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Other Order Fees including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'other_order_fees_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order_update|Order Subsidies including VAT|item', 'PNL', 'SUBSIDY', 'order_subsidies_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Fees including VAT|item', 'PNL', 'MARKETPLACE_FEE', 'non_order_fees_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Subsidies including VAT|item', 'PNL', 'SUBSIDY', 'non_order_subsidies_update', 'NONE', 'ORDER_LINE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order_update|Net Proceeds|order', 'PNL', 'REVENUE', 'net_proceeds_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Returns and later changes to an order; the sign shows the direction. Counted with sales, under review.'),
  ('noon.transaction_view.item_level', 'order_update|Referral Fee including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'referral_fee_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Fullfilment & Logistics Fees including VAT|order', 'PNL', 'FULFILMENT', 'fulfilment_logistics_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Shipping Credits including VAT|order', 'PNL', 'REVENUE', 'shipping_credits_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Other Order Fees including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'other_order_fees_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order_update|Order Subsidies including VAT|order', 'PNL', 'SUBSIDY', 'order_subsidies_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Fees including VAT|order', 'PNL', 'MARKETPLACE_FEE', 'non_order_fees_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Subsidies including VAT|order', 'PNL', 'SUBSIDY', 'non_order_subsidies_update', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'statement_fee|Non-Order Fees including VAT|Advertising Fee', 'PNL', 'ADVERTISING', 'advertising_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon advertising charged on the statement, VAT included; matches the invoices exactly.'),
  ('noon.transaction_view.item_level', 'payment|Others including VAT|Payment Disbursal', 'CASH', 'PAYOUT', 'payment_disbursal', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). A bank transfer noon reports sending. Never revenue.'),
  ('noon.transaction_view.item_level', 'balance_transfer|Others including VAT|', 'CASH', 'TRANSFER', 'balance_transfer', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). A transfer between noon balances; purpose not stated in the file, so under review (B4).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Referral Fee', 'PNL', 'MARKETPLACE_FEE', 'vat_in_referral_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Referral Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Referral Fee', 'TAX', 'FEE_VAT', 'vat_referral_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Referral Fee Adjustment', 'PNL', 'MARKETPLACE_FEE', 'vat_in_referral_fee_adjustment', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Referral Fee Adjustment, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Referral Fee Adjustment', 'TAX', 'FEE_VAT', 'vat_referral_fee_adjustment', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Directship Outbound Fee', 'PNL', 'FULFILMENT', 'vat_in_directship_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Directship Outbound Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Directship Outbound Fee', 'TAX', 'FEE_VAT', 'vat_directship_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|FBN Outbound Fee', 'PNL', 'FULFILMENT', 'vat_in_fbn_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on FBN Outbound Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|FBN Outbound Fee', 'TAX', 'FEE_VAT', 'vat_fbn_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Rebates & Discounts (Directship Outbound Fee)', 'PNL', 'FULFILMENT', 'vat_in_rebates_discounts_directship_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Rebates & Discounts (Directship Outbound Fee), taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Rebates & Discounts (Directship Outbound Fee)', 'TAX', 'FEE_VAT', 'vat_rebates_discounts_directship_outbound_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Shipping Fee Rebate', 'PNL', 'FULFILMENT', 'vat_in_shipping_fee_rebate', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Shipping Fee Rebate, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Shipping Fee Rebate', 'TAX', 'FEE_VAT', 'vat_shipping_fee_rebate', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Advertising Fee', 'PNL', 'ADVERTISING', 'vat_in_advertising_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Advertising Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Advertising Fee', 'TAX', 'FEE_VAT', 'vat_advertising_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Return Administration Fee', 'PNL', 'MARKETPLACE_FEE', 'vat_in_return_administration_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Return Administration Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Return Administration Fee', 'TAX', 'FEE_VAT', 'vat_return_administration_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Cancellation Fee', 'PNL', 'MARKETPLACE_FEE', 'vat_in_cancellation_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Cancellation Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Cancellation Fee', 'TAX', 'FEE_VAT', 'vat_cancellation_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Damaged Returns Fee', 'PNL', 'FULFILMENT', 'vat_in_damaged_returns_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Damaged Returns Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Damaged Returns Fee', 'TAX', 'FEE_VAT', 'vat_damaged_returns_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Warranty Fee', 'PNL', 'MARKETPLACE_FEE', 'vat_in_warranty_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Warranty Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Warranty Fee', 'TAX', 'FEE_VAT', 'vat_warranty_fee', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Import VAT Recovery', 'PNL', 'FULFILMENT', 'vat_in_import_vat_recovery', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Import VAT noon recovered from the seller, charged within the fees; taken out of fees and shown as input VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Import VAT Recovery', 'TAX', 'FEE_VAT', 'vat_import_vat_recovery', 'NONE', 'MARKETPLACE', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Customer|output_vat|Invoice', 'TAX', 'OUTPUT_VAT', 'output_vat_invoice', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). VAT on the sale, as noon invoiced the buyer. Tax only; sales are shown as noon reports them.'),
  ('noon.invoices_credit_notes', 'Customer|output_vat|Creditnote', 'TAX', 'OUTPUT_VAT', 'output_vat_credit_note', 'NONE', 'ORDER', 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). VAT given back on a credit note. Tax only.')
) as r (format_id, match_key, side, category, subcategory, quantity_rule, attribution, evidence)
where not exists (
  select 1 from public.ledger_mapping_rules x
  where x.business_id is null and x.marketplace_code = 'NOON'
    and x.format_id = r.format_id and x.match_key = r.match_key
);

insert into public.classification_rules (
  scope, business_id, marketplace_code, format_id, match_key, category, subcategory, confidence,
  amount_includes_vat, separates_included_vat, evidence
)
select 'GLOBAL', null, 'NOON', r.format_id, r.match_key, r.category, r.subcategory, r.confidence,
       r.includes_vat, r.separates_vat, r.evidence
from (values
  ('noon.transaction_view.item_level', 'order|Net Proceeds|item', 'PRODUCT_SALES', 'Net proceeds', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). What the buyer paid for the item, as noon reports it.'),
  ('noon.transaction_view.item_level', 'order|Referral Fee including VAT|item', 'MARKETPLACE_FEE', 'Referral fee', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Fullfilment & Logistics Fees including VAT|item', 'FULFILLMENT', 'Fulfilment and logistics', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Shipping Credits including VAT|item', 'SHIPPING_INCOME', 'Shipping credits', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Other Order Fees including VAT|item', 'MARKETPLACE_FEE', 'Other order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order|Order Subsidies including VAT|item', 'SUBSIDY_INCOME', 'Order subsidies', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Fees including VAT|item', 'MARKETPLACE_FEE', 'Non-order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Subsidies including VAT|item', 'SUBSIDY_INCOME', 'Non-order subsidies', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order|Net Proceeds|order', 'PRODUCT_SALES', 'Net proceeds', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). What the buyer paid for the item, as noon reports it.'),
  ('noon.transaction_view.item_level', 'order|Referral Fee including VAT|order', 'MARKETPLACE_FEE', 'Referral fee', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Fullfilment & Logistics Fees including VAT|order', 'FULFILLMENT', 'Fulfilment and logistics', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order|Shipping Credits including VAT|order', 'SHIPPING_INCOME', 'Shipping credits', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Other Order Fees including VAT|order', 'MARKETPLACE_FEE', 'Other order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order|Order Subsidies including VAT|order', 'SUBSIDY_INCOME', 'Order subsidies', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Fees including VAT|order', 'MARKETPLACE_FEE', 'Non-order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order|Non-Order Subsidies including VAT|order', 'SUBSIDY_INCOME', 'Non-order subsidies', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order_update|Net Proceeds|item', 'PRODUCT_SALES', 'Order updates', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Returns and later changes to an order; the sign shows the direction. Counted with sales, under review.'),
  ('noon.transaction_view.item_level', 'order_update|Referral Fee including VAT|item', 'MARKETPLACE_FEE', 'Referral fee', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Fullfilment & Logistics Fees including VAT|item', 'FULFILLMENT', 'Fulfilment and logistics', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Shipping Credits including VAT|item', 'SHIPPING_INCOME', 'Shipping credits', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Other Order Fees including VAT|item', 'MARKETPLACE_FEE', 'Other order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order_update|Order Subsidies including VAT|item', 'SUBSIDY_INCOME', 'Order subsidies', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Fees including VAT|item', 'MARKETPLACE_FEE', 'Non-order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Subsidies including VAT|item', 'SUBSIDY_INCOME', 'Non-order subsidies', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'order_update|Net Proceeds|order', 'PRODUCT_SALES', 'Order updates', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Returns and later changes to an order; the sign shows the direction. Counted with sales, under review.'),
  ('noon.transaction_view.item_level', 'order_update|Referral Fee including VAT|order', 'MARKETPLACE_FEE', 'Referral fee', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon''s commission, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Fullfilment & Logistics Fees including VAT|order', 'FULFILLMENT', 'Fulfilment and logistics', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). FBN and Directship outbound fees and their rebates, VAT included.'),
  ('noon.transaction_view.item_level', 'order_update|Shipping Credits including VAT|order', 'SHIPPING_INCOME', 'Shipping credits', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Shipping credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Other Order Fees including VAT|order', 'MARKETPLACE_FEE', 'Other order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Return administration and cancellation fees, VAT included; one column, so under review.'),
  ('noon.transaction_view.item_level', 'order_update|Order Subsidies including VAT|order', 'SUBSIDY_INCOME', 'Order subsidies', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon-funded subsidies credited to the seller.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Fees including VAT|order', 'MARKETPLACE_FEE', 'Non-order fees', 'MEDIUM', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Fees not tied to an order line, such as the warranty fee.'),
  ('noon.transaction_view.item_level', 'order_update|Non-Order Subsidies including VAT|order', 'SUBSIDY_INCOME', 'Non-order subsidies', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Subsidies not tied to an order line.'),
  ('noon.transaction_view.item_level', 'statement_fee|Non-Order Fees including VAT|Advertising Fee', 'ADVERTISING', 'Advertising fee', 'HIGH', true, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). noon advertising charged on the statement, VAT included; matches the invoices exactly.'),
  ('noon.transaction_view.item_level', 'payment|Others including VAT|Payment Disbursal', 'PAYOUT', 'Payment disbursal', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). A bank transfer noon reports sending. Never revenue.'),
  ('noon.transaction_view.item_level', 'balance_transfer|Others including VAT|', 'TRANSFER', 'Balance transfer', 'MEDIUM', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). A transfer between noon balances; purpose not stated in the file, so under review (B4).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Referral Fee', 'MARKETPLACE_FEE', 'VAT included in Referral Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Referral Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Referral Fee', 'INPUT_VAT', 'VAT on Referral Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Referral Fee Adjustment', 'MARKETPLACE_FEE', 'VAT included in Referral Fee Adjustment', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Referral Fee Adjustment, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Referral Fee Adjustment', 'INPUT_VAT', 'VAT on Referral Fee Adjustment', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Directship Outbound Fee', 'FULFILLMENT', 'VAT included in Directship Outbound Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Directship Outbound Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Directship Outbound Fee', 'INPUT_VAT', 'VAT on Directship Outbound Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|FBN Outbound Fee', 'FULFILLMENT', 'VAT included in FBN Outbound Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on FBN Outbound Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|FBN Outbound Fee', 'INPUT_VAT', 'VAT on FBN Outbound Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Rebates & Discounts (Directship Outbound Fee)', 'FULFILLMENT', 'VAT included in Rebates & Discounts (Directship Outbound Fee)', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Rebates & Discounts (Directship Outbound Fee), taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Rebates & Discounts (Directship Outbound Fee)', 'INPUT_VAT', 'VAT on Rebates & Discounts (Directship Outbound Fee)', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Shipping Fee Rebate', 'FULFILLMENT', 'VAT included in Shipping Fee Rebate', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Shipping Fee Rebate, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Shipping Fee Rebate', 'INPUT_VAT', 'VAT on Shipping Fee Rebate', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Advertising Fee', 'ADVERTISING', 'VAT included in Advertising Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Advertising Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Advertising Fee', 'INPUT_VAT', 'VAT on Advertising Fee', 'HIGH', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Return Administration Fee', 'MARKETPLACE_FEE', 'VAT included in Return Administration Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Return Administration Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Return Administration Fee', 'INPUT_VAT', 'VAT on Return Administration Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Cancellation Fee', 'MARKETPLACE_FEE', 'VAT included in Cancellation Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Cancellation Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Cancellation Fee', 'INPUT_VAT', 'VAT on Cancellation Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Damaged Returns Fee', 'FULFILLMENT', 'VAT included in Damaged Returns Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Damaged Returns Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Damaged Returns Fee', 'INPUT_VAT', 'VAT on Damaged Returns Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Warranty Fee', 'MARKETPLACE_FEE', 'VAT included in Warranty Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). The VAT noon charged on Warranty Fee, taken back out of the fee so the fee shows without VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Warranty Fee', 'INPUT_VAT', 'VAT on Warranty Fee', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Statement Fee|vat_included|Import VAT Recovery', 'FULFILLMENT', 'Import VAT charged within fees', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Import VAT noon recovered from the seller, charged within the fees; taken out of fees and shown as input VAT.'),
  ('noon.invoices_credit_notes', 'Statement Fee|input_vat|Import VAT Recovery', 'INPUT_VAT', 'Import VAT recovered by noon', 'MEDIUM', false, true, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). Input VAT as stated on noon''s statement invoice; its P&L effect follows the account VAT setting (B1).'),
  ('noon.invoices_credit_notes', 'Customer|output_vat|Invoice', 'OUTPUT_VAT', 'Output VAT on sales invoices', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). VAT on the sale, as noon invoiced the buyer. Tax only; sales are shown as noon reports them.'),
  ('noon.invoices_credit_notes', 'Customer|output_vat|Creditnote', 'OUTPUT_VAT', 'Output VAT reversed by credit notes', 'HIGH', false, false, 'Built from the owner''s real noon July 2026 Transaction View and Invoices and Credit Notes exports (GCC Phase 5). VAT given back on a credit note. Tax only.')
) as r (format_id, match_key, category, subcategory, confidence, includes_vat, separates_vat, evidence)
where not exists (
  select 1 from public.classification_rules x
  where x.business_id is null and x.marketplace_code = 'NOON'
    and x.format_id = r.format_id and x.match_key = r.match_key
);

update public.marketplaces set adapter_status = 'AVAILABLE' where code = 'NOON';


-- ----------------------------------------------------------------------------
-- 3. Overlapping exports
-- ----------------------------------------------------------------------------

create index if not exists source_rows_row_hash_idx on public.source_rows (row_hash);

create or replace function public.ledger_apply_file(p_file jsonb)
returns table (
  source_file_id       uuid,
  duplicate            boolean,
  rows_written         integer,
  transactions_written integer,
  settlements_written  integer,
  payouts_written      integer,
  issues_written       integer,
  unmapped_written     integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_account_id  uuid;
  v_business_id uuid;
  v_account     public.marketplace_accounts;
  v_existing    uuid;
  v_file_id     uuid;
  v_format      text;
  v_version     text;
  v_sha         text;
  v_file_name   text;
  v_file_type   text;
  v_size        bigint;
  v_source_kind text;
  v_stripped    text[];
  v_problem     text;
  v_key         text;
  v_payout      record;
  v_payout_id   uuid;
  v_rows        integer;
  v_failed      integer;
  v_tx          integer;
  v_st          integer;
  v_po          integer;
  v_is          integer;
  v_unmapped    integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if p_file is null or jsonb_typeof(p_file) <> 'object' then
    raise exception 'The ledger file is not readable.' using errcode = '22023';
  end if;

  -- ---- the account, tenant and role ----------------------------------------
  if coalesce(p_file ->> 'marketplace_account_id', '')
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_account_id := (p_file ->> 'marketplace_account_id')::uuid;
  end if;

  select a.business_id into v_business_id
  from public.marketplace_accounts a where a.id = v_account_id;

  if v_business_id is null
     or v_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That marketplace account could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_business_id, array['OWNER', 'ADMIN', 'STAFF']::public.business_role[]) then
    raise exception 'A viewer cannot import data.' using errcode = '42501';
  end if;

  -- Serialises applies (and restores) per account, so the duplicate and
  -- settlement checks below cannot race.
  select * into v_account from public.marketplace_accounts a where a.id = v_account_id for update;

  if v_account.status <> 'ACTIVE' then
    raise exception 'This marketplace account is archived, so nothing more can be imported into it.'
      using errcode = 'P0001';
  end if;

  -- ---- the file record -----------------------------------------------------
  v_format      := nullif(trim(coalesce(p_file ->> 'format_id', '')), '');
  v_version     := nullif(trim(coalesce(p_file ->> 'adapter_version', '')), '');
  v_sha         := p_file ->> 'file_sha256';
  v_file_name   := nullif(trim(coalesce(p_file ->> 'file_name', '')), '');
  v_file_type   := p_file ->> 'file_type';
  v_source_kind := coalesce(nullif(p_file ->> 'source_kind', ''), 'UPLOAD');

  if v_format is null or length(v_format) > 120 then
    raise exception 'format_id is required.' using errcode = '22023';
  end if;
  if v_version is null or length(v_version) > 40 then
    raise exception 'adapter_version is required.' using errcode = '22023';
  end if;
  if coalesce(v_sha, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'file_sha256 must be a lowercase SHA-256 hex digest.' using errcode = '22023';
  end if;
  if v_file_name is null or length(v_file_name) > 255 or public.ledger_text_has_email(v_file_name) then
    raise exception 'file_name is required, at most 255 characters, and may not contain an email address.'
      using errcode = '22023';
  end if;
  if coalesce(v_file_type, '') not in ('csv', 'xlsx', 'txt') then
    raise exception 'file_type must be csv, xlsx or txt.' using errcode = '22023';
  end if;
  if coalesce(p_file ->> 'file_size_bytes', '') !~ '^[0-9]{1,12}$' then
    raise exception 'file_size_bytes must be a whole number.' using errcode = '22023';
  end if;
  v_size := (p_file ->> 'file_size_bytes')::bigint;
  if v_source_kind not in ('UPLOAD', 'API') then
    raise exception 'source_kind must be UPLOAD or API.' using errcode = '22023';
  end if;

  foreach v_key in array array['columns', 'stripped_columns', 'settlements', 'payouts', 'transactions', 'issues']
  loop
    if p_file ? v_key and jsonb_typeof(p_file -> v_key) <> 'array' then
      raise exception '% must be an array.', v_key using errcode = '22023';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_file -> 'columns', '[]') || coalesce(p_file -> 'stripped_columns', '[]')) e
    where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 300
       or public.ledger_text_has_email(e #>> '{}')
  ) then
    raise exception 'columns and stripped_columns must be lists of column names.' using errcode = '22023';
  end if;

  v_stripped := array(select jsonb_array_elements_text(coalesce(p_file -> 'stripped_columns', '[]')));

  -- ---- the same file again is a no-op --------------------------------------
  select b.id into v_existing
  from public.import_batches b
  where b.dataset = 'LEDGER'
    and b.marketplace_account_id = v_account.id
    and b.file_sha256 = v_sha
    and b.withdrawn_at is null;

  if v_existing is not null then
    return query select v_existing, true, 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- ---- stage the payload ---------------------------------------------------
  if jsonb_typeof(p_file -> 'rows') is distinct from 'array'
     or jsonb_array_length(p_file -> 'rows') = 0 then
    raise exception 'A ledger file needs at least one source row.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_file -> 'rows') > 50000 then
    raise exception 'A ledger file may hold at most 50,000 rows. Split it and apply each part.'
      using errcode = '22023';
  end if;

  drop table if exists pg_temp.ledger_in_rows;
  drop table if exists pg_temp.ledger_rows;
  drop table if exists pg_temp.ledger_in_settlements;
  drop table if exists pg_temp.ledger_in_payouts;
  drop table if exists pg_temp.ledger_in_transactions;
  drop table if exists pg_temp.ledger_in_issues;
  drop table if exists pg_temp.ledger_payout_ids;

  create temporary table ledger_in_rows on commit drop as
    select e.ordinality::integer as position, e.value as v
    from jsonb_array_elements(p_file -> 'rows') with ordinality e;

  -- ---- source rows ---------------------------------------------------------
  select format('Source row %s is not readable: it needs a row_number and an object of raw values.', r.position)
  into v_problem
  from pg_temp.ledger_in_rows r
  where jsonb_typeof(r.v) <> 'object'
     or coalesce(r.v ->> 'row_number', '') !~ '^[1-9][0-9]{0,6}$'
     or jsonb_typeof(r.v -> 'raw') is distinct from 'object'
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row number %s appears more than once.', r.v ->> 'row_number')
  into v_problem
  from pg_temp.ledger_in_rows r
  group by r.v ->> 'row_number'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s contains the customer-data column "%s". Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where public.ledger_is_customer_column(e.key)
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", contains an email address. Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) = 'string' and public.ledger_text_has_email(e.value #>> '{}')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", is not text. Source values are stored exactly as read, as text or blank.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) not in ('string', 'null')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  create temporary table ledger_rows on commit drop as
    select (r.v ->> 'row_number')::integer as row_number, r.v -> 'raw' as raw
    from pg_temp.ledger_in_rows r;
  create unique index on pg_temp.ledger_rows (row_number);

  create temporary table ledger_in_settlements on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'settlements', '[]')) with ordinality e;

  create temporary table ledger_in_payouts on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'payouts', '[]')) with ordinality e;

  create temporary table ledger_in_transactions on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'transactions', '[]')) with ordinality e;
  create index on pg_temp.ledger_in_transactions (row_no);

  create temporary table ledger_in_issues on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'issues', '[]')) with ordinality e;

  -- ---- settlements ---------------------------------------------------------
  select format('Settlement %s: %s', s.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_settlements s
  cross join lateral (
    select case
      when jsonb_typeof(s.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(s.v -> 'external_settlement_id') is distinct from 'string'
           or length(s.v ->> 'external_settlement_id') not between 1 and 200
           or public.ledger_text_has_email(s.v ->> 'external_settlement_id')
        then 'external_settlement_id is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = s.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(s.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(s.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(s.v -> 'reported_total')
                or public.ledger_json_is_money(s.v -> 'reported_total'))
        then 'reported_total must be exact decimal text or blank'
      when not (public.ledger_json_is_absent(s.v -> 'period_start') or public.ledger_json_is_instant(s.v -> 'period_start'))
        or not (public.ledger_json_is_absent(s.v -> 'period_end') or public.ledger_json_is_instant(s.v -> 'period_end'))
        or not (public.ledger_json_is_absent(s.v -> 'reported_deposit_date') or public.ledger_json_is_instant(s.v -> 'reported_deposit_date'))
        then 'its dates must be timestamps with a time zone, or blank'
    end as problem
  ) x
  where x.problem is not null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Settlement %s appears more than once in this file.', s.v ->> 'external_settlement_id')
  into v_problem
  from pg_temp.ledger_in_settlements s
  group by s.v ->> 'external_settlement_id'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- Decision B8: the same settlement may count once. A different file carrying
  -- it is refused, with the file already counting it named.
  select format('Settlement %s is already counted from the file "%s". Withdraw that file first if this one replaces it.',
                s.v ->> 'external_settlement_id', b.file_name)
  into v_problem
  from pg_temp.ledger_in_settlements s
  join public.settlements st
    on st.marketplace_account_id = v_account.id
   and st.external_settlement_id = s.v ->> 'external_settlement_id'
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- ---- payouts -------------------------------------------------------------
  select format('Payout %s: %s', p.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_payouts p
  cross join lateral (
    select case
      when jsonb_typeof(p.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(p.v -> 'key') is distinct from 'string'
           or length(p.v ->> 'key') not between 1 and 80
        then 'key is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = p.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when public.ledger_json_is_absent(p.v -> 'amount')
        then 'its amount is blank. A payout without an amount is a row issue, not a payout'
      when not public.ledger_json_is_money(p.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(p.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(p.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(p.v -> 'paid_at') or public.ledger_json_is_instant(p.v -> 'paid_at'))
        then 'paid_at must be a timestamp with a time zone, or blank'
      when not public.ledger_json_is_optional_text(p.v -> 'external_ref', 200)
        then 'external_ref is too long or contains an email address'
      when coalesce(p.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = p.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
    end as problem
  ) x
  where x.problem is not null
  order by p.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Payout key %s appears more than once.', p.v ->> 'key')
  into v_problem
  from pg_temp.ledger_in_payouts p
  group by p.v ->> 'key'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- transactions --------------------------------------------------------
  select format('Transaction %s: %s', t.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_transactions t
  left join public.ledger_mapping_rules mr
    on mr.id = case
                 when coalesce(t.v ->> 'mapping_rule_id', '')
                      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (t.v ->> 'mapping_rule_id')::uuid
               end
  cross join lateral (
    select case
      when jsonb_typeof(t.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = t.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(t.v ->> 'line_index', '0') !~ '^[0-9]{1,4}$'
        then 'line_index must be a whole number'
      when coalesce(t.v ->> 'attribution', '') not in ('ORDER_LINE', 'ORDER', 'MARKETPLACE')
        then 'attribution must be ORDER_LINE, ORDER or MARKETPLACE'
      when public.ledger_json_is_absent(t.v -> 'amount')
        then 'its amount is blank. A blank amount is recorded as a row issue, never as a transaction'
      when not public.ledger_json_is_money(t.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(t.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(t.v ->> 'currency', '(blank)'), v_account.currency)
      when not public.ledger_json_is_instant(t.v -> 'posted_at')
        then 'posted_at must be a timestamp with a time zone'
      when not public.ledger_json_is_optional_text(t.v -> 'source_type', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_subtype', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_description', 500)
        or not public.ledger_json_is_optional_text(t.v -> 'order_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'order_line_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'raw_sku', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'subcategory', 80)
        then 'a text field is too long or contains an email address'
      when not (public.ledger_json_is_absent(t.v -> 'quantity') or public.ledger_json_is_money(t.v -> 'quantity'))
        then 'quantity must be exact decimal text, or blank'
      when public.ledger_json_is_absent(t.v -> 'quantity') <> (coalesce(t.v ->> 'quantity_basis', '') = '')
        then 'quantity and quantity_basis must be given together'
      when coalesce(t.v ->> 'quantity_basis', '') not in ('', 'REPORTED', 'DERIVED_LINE_COUNT')
        then 'quantity_basis must be REPORTED or DERIVED_LINE_COUNT'
      when coalesce(t.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = t.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
      when coalesce(t.v ->> 'payout_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_payouts p where p.v ->> 'key' = t.v ->> 'payout_ref')
        then 'its payout_ref names no payout in this file'
      when coalesce(t.v ->> 'mapping_rule_id', '') = '' then
        case
          when t.v ->> 'category' is distinct from 'UNMAPPED'
            then 'a transaction without a mapping rule must be UNMAPPED'
          when coalesce(t.v ->> 'side', '') <> '' or coalesce(t.v ->> 'subcategory', '') <> ''
            then 'an UNMAPPED transaction has no side and no subcategory'
        end
      when mr.id is null then 'its mapping rule does not exist'
      when mr.status <> 'ACTIVE' then 'its mapping rule is retired'
      when mr.marketplace_code <> v_account.marketplace_code or mr.format_id <> v_format
        then 'its mapping rule belongs to a different marketplace or format'
      when mr.scope = 'BUSINESS' and mr.business_id is distinct from v_account.business_id
        then 'its mapping rule belongs to a different business'
      when t.v ->> 'side' is distinct from mr.side
        or t.v ->> 'category' is distinct from mr.category
        or coalesce(t.v ->> 'subcategory', '') <> coalesce(mr.subcategory, '')
        or t.v ->> 'attribution' is distinct from mr.attribution
        then 'its side, category, subcategory or attribution differ from its mapping rule'
      when mr.quantity_rule = 'NONE' and coalesce(t.v ->> 'quantity_basis', '') <> ''
        then 'its mapping rule records no quantity'
      when mr.quantity_rule = 'REPORTED' and coalesce(t.v ->> 'quantity_basis', 'REPORTED') <> 'REPORTED'
        then 'its mapping rule takes the quantity as reported'
      when mr.quantity_rule = 'COUNT_LINE' and t.v ->> 'quantity_basis' is distinct from 'DERIVED_LINE_COUNT'
        then 'its mapping rule counts the line as one unit, so quantity_basis must be DERIVED_LINE_COUNT'
    end as problem
  ) x
  where x.problem is not null
  order by t.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s has more than one transaction with line_index %s.',
                t.row_no, coalesce(t.v ->> 'line_index', '0'))
  into v_problem
  from pg_temp.ledger_in_transactions t
  group by t.row_no, coalesce(t.v ->> 'line_index', '0')
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- issues --------------------------------------------------------------
  select format('Row issue %s: %s', i.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_issues i
  cross join lateral (
    select case
      when jsonb_typeof(i.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = i.row_no)
        then 'its row_number matches no source row'
      when coalesce(i.v ->> 'severity', '') not in ('ERROR', 'WARNING')
        then 'severity must be ERROR or WARNING'
      when jsonb_typeof(i.v -> 'message') is distinct from 'string'
           or length(i.v ->> 'message') not between 1 and 500
           or public.ledger_text_has_email(i.v ->> 'message')
        then 'message is required and may not contain an email address'
      when not public.ledger_json_is_optional_text(i.v -> 'field', 120)
        or not public.ledger_json_is_optional_text(i.v -> 'raw_value', 500)
        then 'field or raw_value is too long or contains an email address'
    end as problem
  ) x
  where x.problem is not null
  order by i.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- nothing is silently dropped ------------------------------------------
  select format('Source row %s is not used by any transaction, settlement, payout or row issue. Every row must be accounted for.',
                r.row_number)
  into v_problem
  from pg_temp.ledger_rows r
  where not exists (select 1 from pg_temp.ledger_in_transactions t where t.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_settlements s where s.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_payouts p where p.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_issues i where i.row_no = r.row_number)
  order by r.row_number
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- overlap (migration 0034) --------------------------------------------
  -- Report exports can cover overlapping periods. A row identical to one in a
  -- file still counting for this account would be counted twice, so the file
  -- is refused, naming the file that already holds it.
  select format('This file repeats %s row(s) already counted from the file "%s". Withdraw that file first, or upload a period that does not overlap.',
                count(*), min(b.file_name))
  into v_problem
  from pg_temp.ledger_rows r
  join public.source_rows sr
    on sr.row_hash = encode(sha256(convert_to(r.raw::text, 'UTF8')), 'hex')
  join public.import_batches b on b.id = sr.source_file_id
  where b.marketplace_account_id = v_account.id
    and b.dataset = 'LEDGER'
    and b.withdrawn_at is null
  having count(*) > 0;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- ---- write ---------------------------------------------------------------
  perform set_config('bizmind.ledger_writer', 'on', true);

  select count(*) into v_rows from pg_temp.ledger_rows;
  select count(distinct i.row_no) into v_failed
  from pg_temp.ledger_in_issues i where i.v ->> 'severity' = 'ERROR';
  select count(*) into v_tx from pg_temp.ledger_in_transactions;

  insert into public.import_batches (
    business_id, created_by, entity, status, file_name, file_type, file_size_bytes,
    columns, raw_rows, row_count, rows_valid, rows_failed, created_count, updated_count,
    committed_at, dataset, source_kind, marketplace_account_id, format_id, adapter_version,
    file_sha256, stripped_columns
  )
  values (
    v_account.business_id, v_uid, 'LEDGER', 'COMPLETED', v_file_name, v_file_type, v_size,
    coalesce(p_file -> 'columns', '[]'), '[]', v_rows, v_rows - v_failed, v_failed, v_tx, 0,
    now(), 'LEDGER', v_source_kind, v_account.id, v_format, v_version,
    v_sha, v_stripped
  )
  returning id into v_file_id;

  insert into public.source_rows (business_id, source_file_id, row_number, raw, row_hash)
  select v_account.business_id, v_file_id, r.row_number, r.raw,
         encode(sha256(convert_to(r.raw::text, 'UTF8')), 'hex')
  from pg_temp.ledger_rows r
  order by r.row_number;

  insert into public.settlements (
    business_id, marketplace_account_id, source_file_id, source_row_id, external_settlement_id,
    period_start, period_end, reported_total, reported_deposit_date, currency
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id, s.v ->> 'external_settlement_id',
         (s.v ->> 'period_start')::timestamptz, (s.v ->> 'period_end')::timestamptz,
         (s.v ->> 'reported_total')::numeric, (s.v ->> 'reported_deposit_date')::timestamptz,
         v_account.currency
  from pg_temp.ledger_in_settlements s
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = s.row_no
  order by s.position;
  get diagnostics v_st = row_count;

  create temporary table ledger_payout_ids (key text primary key, id uuid not null) on commit drop;

  v_po := 0;
  for v_payout in
    select p.v, sr.id as source_row_id, st.id as settlement_id
    from pg_temp.ledger_in_payouts p
    join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = p.row_no
    left join public.settlements st
      on st.source_file_id = v_file_id and st.external_settlement_id = p.v ->> 'settlement_ref'
    order by p.position
  loop
    insert into public.payouts (
      business_id, marketplace_account_id, origin, source_file_id, source_row_id, settlement_id,
      external_ref, amount, currency, paid_at
    )
    values (
      v_account.business_id, v_account.id, 'SOURCE_FILE', v_file_id, v_payout.source_row_id,
      v_payout.settlement_id, v_payout.v ->> 'external_ref', (v_payout.v ->> 'amount')::numeric,
      v_account.currency, (v_payout.v ->> 'paid_at')::timestamptz
    )
    returning id into v_payout_id;

    insert into pg_temp.ledger_payout_ids (key, id) values (v_payout.v ->> 'key', v_payout_id);
    v_po := v_po + 1;
  end loop;

  insert into public.financial_transactions (
    business_id, marketplace_account_id, source_file_id, source_row_id, line_index,
    mapping_rule_id, side, category, subcategory, source_type, source_subtype, source_description,
    amount, currency, posted_at, order_ref, order_line_ref, raw_sku, quantity, quantity_basis,
    attribution, settlement_id, payout_id
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id,
         coalesce((t.v ->> 'line_index')::smallint, 0),
         nullif(t.v ->> 'mapping_rule_id', '')::uuid,
         nullif(t.v ->> 'side', ''), t.v ->> 'category', nullif(t.v ->> 'subcategory', ''),
         t.v ->> 'source_type', t.v ->> 'source_subtype', t.v ->> 'source_description',
         (t.v ->> 'amount')::numeric, v_account.currency, (t.v ->> 'posted_at')::timestamptz,
         t.v ->> 'order_ref', t.v ->> 'order_line_ref', t.v ->> 'raw_sku',
         (t.v ->> 'quantity')::numeric, nullif(t.v ->> 'quantity_basis', ''),
         t.v ->> 'attribution', st.id, po.id
  from pg_temp.ledger_in_transactions t
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = t.row_no
  left join public.settlements st
    on st.source_file_id = v_file_id and st.external_settlement_id = t.v ->> 'settlement_ref'
  left join pg_temp.ledger_payout_ids po on po.key = t.v ->> 'payout_ref'
  order by t.position;

  insert into public.import_issues (business_id, batch_id, row_number, severity, field, message, raw_value)
  select v_account.business_id, v_file_id, i.row_no, i.v ->> 'severity', i.v ->> 'field',
         i.v ->> 'message', i.v ->> 'raw_value'
  from pg_temp.ledger_in_issues i
  order by i.position;
  get diagnostics v_is = row_count;

  select count(*) into v_unmapped
  from public.financial_transactions ft
  where ft.source_file_id = v_file_id and ft.category = 'UNMAPPED';

  perform public.write_audit_log(
    v_account.business_id, 'ledger.file_applied', 'import_batches', v_file_id, null,
    jsonb_build_object(
      'file_name', v_file_name,
      'format_id', v_format,
      'adapter_version', v_version,
      'file_sha256', v_sha,
      'marketplace_account_id', v_account.id,
      'rows', v_rows,
      'transactions', v_tx,
      'settlements', v_st,
      'payouts', v_po,
      'issues', v_is,
      'unmapped', v_unmapped,
      'stripped_columns', to_jsonb(v_stripped),
      'totals', (
        select coalesce(jsonb_object_agg(x.k, x.total), '{}')
        from (
          select coalesce(ft.side, 'UNMAPPED') || '.' || ft.category as k, sum(ft.amount)::text as total
          from public.financial_transactions ft
          where ft.source_file_id = v_file_id
          group by 1
        ) x
      )
    )
  );

  return query select v_file_id, false, v_rows, v_tx, v_st, v_po, v_is, v_unmapped;
end;
$$;

create or replace function public.ledger_file_restore(p_source_file_id uuid)
returns table (
  transactions_restored bigint,
  settlements_restored  bigint,
  payouts_restored      bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file    public.import_batches;
  v_problem text;
  v_tx      bigint;
  v_st      bigint;
  v_po      bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_file from public.import_batches b where b.id = p_source_file_id;

  if v_file.id is null
     or v_file.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That file could not be found.' using errcode = 'P0002';
  end if;

  if v_file.dataset <> 'LEDGER' then
    raise exception 'This is not a ledger file. Restore it from Data Sources.' using errcode = 'P0001';
  end if;

  if not public.current_user_has_role(v_file.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can restore a file.' using errcode = '42501';
  end if;

  -- Same lock order as ledger_apply_file: the account, then the file.
  perform 1 from public.marketplace_accounts a where a.id = v_file.marketplace_account_id for update;
  select * into v_file from public.import_batches b where b.id = p_source_file_id for update;

  if v_file.withdrawn_at is null then
    raise exception 'This file is not withdrawn.' using errcode = 'P0001';
  end if;

  select format('An identical file ("%s") is already counting. Withdraw it before restoring this one.', b.file_name)
  into v_problem
  from public.import_batches b
  where b.dataset = 'LEDGER'
    and b.marketplace_account_id = v_file.marketplace_account_id
    and b.file_sha256 = v_file.file_sha256
    and b.withdrawn_at is null
    and b.id <> v_file.id
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  select format('Settlement %s is already counted from the file "%s". Withdraw that file before restoring this one.',
                mine.external_settlement_id, b.file_name)
  into v_problem
  from public.settlements mine
  join public.settlements other
    on other.marketplace_account_id = mine.marketplace_account_id
   and other.external_settlement_id = mine.external_settlement_id
   and other.source_file_id <> mine.source_file_id
  join public.import_batches b on b.id = other.source_file_id and b.withdrawn_at is null
  where mine.source_file_id = v_file.id
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- Migration 0034: its rows may since have been uploaded again in another file.
  select format('%s of this file''s rows are already counted from the file "%s". Withdraw that file before restoring this one.',
                count(*), min(b.file_name))
  into v_problem
  from public.source_rows mine
  join public.source_rows other
    on other.row_hash = mine.row_hash
   and other.source_file_id <> mine.source_file_id
  join public.import_batches b
    on b.id = other.source_file_id
   and b.withdrawn_at is null
   and b.dataset = 'LEDGER'
   and b.marketplace_account_id = v_file.marketplace_account_id
  where mine.source_file_id = v_file.id
  having count(*) > 0;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  perform set_config('bizmind.ledger_writer', 'on', true);
  perform set_config('bizmind.lineage_writer', 'on', true);

  update public.import_batches b
  set withdrawn_at = null, withdrawn_by = null, withdrawal_reason = null
  where b.id = v_file.id;

  select count(*) into v_tx from public.financial_transactions ft where ft.source_file_id = v_file.id;
  select count(*) into v_st from public.settlements st where st.source_file_id = v_file.id;
  select count(*) into v_po from public.payouts po where po.source_file_id = v_file.id;

  perform public.write_audit_log(
    v_file.business_id, 'ledger.file_restored', 'import_batches', v_file.id,
    jsonb_build_object('withdrawn_at', v_file.withdrawn_at, 'reason', v_file.withdrawal_reason),
    jsonb_build_object('transactions', v_tx, 'settlements', v_st, 'payouts', v_po)
  );

  return query select v_tx, v_st, v_po;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. The classified lines, with the VAT flags
-- ----------------------------------------------------------------------------
-- Columns are only appended, so CREATE OR REPLACE keeps every dependant.

create or replace view public.ledger_classified_lines
with (security_invoker = true)
as
select
  ft.id,
  ft.business_id,
  ft.marketplace_account_id,
  a.marketplace_code,
  a.label                                        as account_label,
  ft.source_file_id,
  b.format_id,
  ft.source_row_id,
  ft.line_index,
  public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
  ft.source_type,
  ft.source_subtype,
  ft.source_description,
  ft.amount::text                                as amount,
  ft.currency,
  ft.posted_at,
  ft.order_ref,
  ft.raw_sku,
  ft.side                                        as import_side,
  ft.category                                    as import_category,
  r.id                                           as rule_id,
  r.scope                                        as rule_scope,
  r.confidence                                   as rule_confidence,
  r.version                                      as rule_version,
  c.financial_type,
  r.category,
  c.label                                        as category_label,
  r.subcategory,
  c.metric_group,
  c.default_treatment,
  case
    when r.id is null then null
    when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
    when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
    when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
    else 'CONDITIONAL'
  end                                            as pnl_treatment,
  case
    when r.id is null then 'UNKNOWN'
    when r.scope = 'GLOBAL' and r.confidence = 'MEDIUM' then 'UNDER_REVIEW'
    else 'CLASSIFIED'
  end                                            as classification_status,
  coalesce(r.amount_includes_vat, false)         as rule_includes_vat,
  coalesce(r.separates_included_vat, false)      as rule_separates_vat
from public.financial_transactions ft
join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
join public.marketplace_accounts a on a.id = ft.marketplace_account_id
left join public.tax_profiles tp on tp.marketplace_account_id = ft.marketplace_account_id
left join lateral (
  select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory,
         cr.amount_includes_vat, cr.separates_included_vat
  from public.classification_rules cr
  where cr.status = 'ACTIVE'
    and cr.marketplace_code = a.marketplace_code
    and cr.format_id = b.format_id
    and cr.match_key = public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
    and (cr.business_id is null or cr.business_id = ft.business_id)
  order by case
             when cr.business_id is null and cr.confidence = 'HIGH' then 1
             when cr.business_id is not null then 2
             else 3
           end
  limit 1
) r on true
left join public.classification_categories c on c.code = r.category;


-- ----------------------------------------------------------------------------
-- 5. pnl_summary(): business filter, currency totals, fee VAT not separated
-- ----------------------------------------------------------------------------

drop function public.pnl_summary(timestamptz, timestamptz, uuid);

create function public.pnl_summary(
  p_from                 timestamptz,
  p_to                   timestamptz,
  p_account_id           uuid default null,
  p_business_id          uuid default null,
  p_combine_by_currency  boolean default false
)
returns table (
  marketplace_account_id          uuid,
  account_label                   text,
  marketplace_code                text,
  currency                        char(3),
  period_from                     timestamptz,
  period_to                       timestamptz,
  gross_sales                     text,
  sales_refunds                   text,
  seller_discounts                text,
  net_sales                       text,
  other_income                    text,
  marketplace_fees                text,
  fulfillment                     text,
  advertising                     text,
  other_marketplace_costs         text,
  non_recoverable_vat             text,
  contribution                    text,
  contribution_status             text,
  contribution_before_open_items  text,
  figures_status                  text,
  input_vat_recoverable           text,
  input_vat_unresolved            text,
  output_vat                      text,
  input_vat_treatment             text,
  lines                           bigint,
  unknown_lines                   bigint,
  unknown_amount                  text,
  review_lines                    bigint,
  review_amount                   text,
  conditional_lines               bigint,
  row_errors                      bigint,
  incomplete_reasons              text[],
  accounts                        bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*, l.amount::numeric(20,4) as amt
  from public.ledger_classified_lines l
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
files as (
  select distinct s.marketplace_account_id, s.source_file_id from scoped s
),
errors as (
  select f.marketplace_account_id, count(*) as n
  from files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id
),
per_account as (
  select
    s.marketplace_account_id,
    s.account_label,
    s.marketplace_code,
    s.currency,
    coalesce(sum(s.amt) filter (where s.metric_group = 'GROSS_SALES'), 0)             as gross_sales,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SALES_REFUNDS'), 0)           as sales_refunds,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SELLER_DISCOUNTS'), 0)        as seller_discounts,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_INCOME'), 0)            as other_income,
    coalesce(sum(s.amt) filter (where s.metric_group = 'MARKETPLACE_FEES'), 0)        as marketplace_fees,
    coalesce(sum(s.amt) filter (where s.metric_group = 'FULFILLMENT'), 0)             as fulfillment,
    coalesce(sum(s.amt) filter (where s.metric_group = 'ADVERTISING'), 0)             as advertising,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_MARKETPLACE_COSTS'), 0) as other_costs,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'INCREASE_EXPENSE'), 0)        as nonrec_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'NO_PNL_IMPACT'), 0)           as rec_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'CONDITIONAL'), 0)            as unresolved_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OUTPUT_VAT'), 0)              as output_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in
      ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)                as pnl_known,
    count(*)                                                                         as lines,
    count(*) filter (where s.classification_status = 'UNKNOWN')                      as unknown_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNKNOWN'), 0)        as unknown_amount,
    count(*) filter (where s.classification_status = 'UNDER_REVIEW')                 as review_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNDER_REVIEW'), 0)   as review_amount,
    count(*) filter (where s.pnl_treatment = 'CONDITIONAL')                          as conditional_lines,
    (bool_or(s.rule_includes_vat) and not bool_or(s.rule_separates_vat))             as vat_inside_fees
  from scoped s
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency
),
judged_account as (
  select
    pa.*,
    coalesce(e.n, 0)                                          as row_error_count,
    coalesce(tp.input_vat_treatment, 'UNKNOWN')               as vat_setting,
    (pa.vat_inside_fees
      and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE') as vat_not_separated
  from per_account pa
  left join errors e on e.marketplace_account_id = pa.marketplace_account_id
  left join public.tax_profiles tp on tp.marketplace_account_id = pa.marketplace_account_id
),
grouped as (
  select
    case when p_combine_by_currency then null else j.marketplace_account_id end as account_id,
    j.currency,
    case when p_combine_by_currency then 'All ' || j.currency || ' accounts' else min(j.account_label) end as label,
    case when count(distinct j.marketplace_code) = 1 then min(j.marketplace_code) else 'MIXED' end as code,
    case when count(distinct j.vat_setting) = 1 then min(j.vat_setting) else 'MIXED' end as vat_setting,
    sum(j.gross_sales) as gross_sales, sum(j.sales_refunds) as sales_refunds,
    sum(j.seller_discounts) as seller_discounts, sum(j.other_income) as other_income,
    sum(j.marketplace_fees) as marketplace_fees, sum(j.fulfillment) as fulfillment,
    sum(j.advertising) as advertising, sum(j.other_costs) as other_costs,
    sum(j.nonrec_vat) as nonrec_vat, sum(j.rec_vat) as rec_vat,
    sum(j.unresolved_vat) as unresolved_vat, sum(j.output_vat) as output_vat,
    sum(j.pnl_known) as pnl_known,
    sum(j.lines)::bigint as lines, sum(j.unknown_lines)::bigint as unknown_lines,
    sum(j.unknown_amount) as unknown_amount, sum(j.review_lines)::bigint as review_lines,
    sum(j.review_amount) as review_amount, sum(j.conditional_lines)::bigint as conditional_lines,
    sum(j.row_error_count)::bigint as row_error_count,
    bool_or(j.vat_not_separated) as vat_not_separated,
    count(*)::bigint as accounts
  from judged_account j
  group by case when p_combine_by_currency then null else j.marketplace_account_id end, j.currency
),
judged as (
  select
    g.*,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated) as figures_incomplete,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated
      or g.conditional_lines > 0)                                        as contribution_incomplete
  from grouped g
)
select
  j.account_id,
  j.label,
  j.code,
  j.currency::char(3),
  p_from,
  p_to,
  j.gross_sales::numeric(20,4)::text,
  j.sales_refunds::numeric(20,4)::text,
  j.seller_discounts::numeric(20,4)::text,
  (j.gross_sales + j.sales_refunds + j.seller_discounts)::numeric(20,4)::text,
  j.other_income::numeric(20,4)::text,
  j.marketplace_fees::numeric(20,4)::text,
  j.fulfillment::numeric(20,4)::text,
  j.advertising::numeric(20,4)::text,
  j.other_costs::numeric(20,4)::text,
  j.nonrec_vat::numeric(20,4)::text,
  case when j.contribution_incomplete then null else j.pnl_known::numeric(20,4)::text end,
  case when j.contribution_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.pnl_known::numeric(20,4)::text,
  case when j.figures_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.rec_vat::numeric(20,4)::text,
  j.unresolved_vat::numeric(20,4)::text,
  j.output_vat::numeric(20,4)::text,
  j.vat_setting,
  j.lines,
  j.unknown_lines,
  j.unknown_amount::numeric(20,4)::text,
  j.review_lines,
  j.review_amount::numeric(20,4)::text,
  j.conditional_lines,
  j.row_error_count,
  array_remove(array[
    case when j.unknown_lines > 0 then 'UNKNOWN_LINES' end,
    case when j.conditional_lines > 0 then 'VAT_TREATMENT_UNKNOWN' end,
    case when j.vat_not_separated then 'FEE_VAT_NOT_SEPARATED' end,
    case when j.row_error_count > 0 then 'ROW_ERRORS' end
  ], null),
  j.accounts
from judged j
order by j.currency, j.label;
$$;

comment on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) is
  'Figures per marketplace account (or per currency when combined) for [p_from, p_to). '
  'contribution is NULL unless FINAL; contribution_before_open_items is informational only.';


-- ----------------------------------------------------------------------------
-- 6. ledger_data_quality(): fee VAT not separated, per month
-- ----------------------------------------------------------------------------

drop function public.ledger_data_quality(timestamptz, timestamptz, uuid, uuid);

create function public.ledger_data_quality(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  issue_kind             text,
  severity               text,
  marketplace_account_id uuid,
  account_label          text,
  marketplace_code       text,
  currency               char(3),
  format_id              text,
  reference              text,
  category               text,
  subcategory            text,
  lines                  bigint,
  amount                 text,
  files                  bigint,
  detail                 text
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*
  from public.ledger_classified_lines l
  where (p_from is null or l.posted_at >= p_from)
    and (p_to is null or l.posted_at < p_to)
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
scoped_files as (
  select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
  from scoped s
),
issues as (
  select
    'UNKNOWN_CODE'::text                                 as issue_kind,
    'WARNING'::text                                      as severity,
    s.marketplace_account_id                             as marketplace_account_id,
    s.account_label                                      as account_label,
    s.marketplace_code                                   as marketplace_code,
    s.currency::char(3)                                  as currency,
    s.format_id                                          as format_id,
    s.match_key                                          as reference,
    null::text                                           as category,
    null::text                                           as subcategory,
    count(*)                                             as lines,
    sum(s.amount::numeric(20,4))::numeric(20,4)::text    as amount,
    count(distinct s.source_file_id)                     as files,
    'Not classified yet. Kept with its amount; counts towards no figure, and the figures it could affect are incomplete.'::text as detail
  from scoped s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

  union all

  select
    'UNDER_REVIEW', 'INFO', s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency::char(3),
    s.format_id, s.match_key, s.category, s.subcategory,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'Counted using a medium-confidence rule. Check it against the marketplace report.'
  from scoped s
  where s.classification_status = 'UNDER_REVIEW'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id,
           s.match_key, s.category, s.subcategory

  union all

  select
    'VAT_TREATMENT_UNKNOWN', 'WARNING', s.marketplace_account_id, s.account_label, s.marketplace_code,
    s.currency::char(3), null, null, 'INPUT_VAT', null,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'The VAT setting for this account is Unknown, so contribution is incomplete. Set it once your accountant confirms whether this VAT is recoverable.'
  from scoped s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

  union all

  select
    'FEE_VAT_NOT_SEPARATED', 'WARNING', s.marketplace_account_id, s.account_label, s.marketplace_code,
    s.currency::char(3), null, to_char(date_trunc('month', s.posted_at at time zone 'UTC'), 'YYYY-MM'), null, null,
    count(*) filter (where s.rule_includes_vat),
    (sum(s.amount::numeric(20,4)) filter (where s.rule_includes_vat))::numeric(20,4)::text,
    count(distinct s.source_file_id),
    'These fees include VAT that is not separated yet, so fees and contribution are incomplete for this month. Upload the marketplace''s VAT invoices for the month (noon: Invoices and Credit Notes).'
  from scoped s
  left join public.tax_profiles tp on tp.marketplace_account_id = s.marketplace_account_id
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency,
           date_trunc('month', s.posted_at at time zone 'UTC'), tp.input_vat_treatment
  having bool_or(s.rule_includes_vat)
     and not bool_or(s.rule_separates_vat)
     and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE'

  union all

  select
    'ROW_ERRORS', 'WARNING', f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency::char(3),
    null, null, null, null,
    count(*), null, count(distinct f.source_file_id),
    'Rows in these files could not be read, so the figures they belong to are incomplete.'
  from scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

  union all

  select
    'SETTLEMENT_MISMATCH', 'WARNING', st.marketplace_account_id, a.label, a.marketplace_code, st.currency::char(3),
    null, st.external_settlement_id, null, null,
    count(ft.id), (st.reported_total - coalesce(sum(ft.amount), 0))::numeric(20,4)::text, 1::bigint,
    'The total the marketplace reported differs from the sum of its lines by this amount.'
  from public.settlements st
  join (select distinct sf.source_file_id from scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
           st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
)
select * from issues
order by severity desc, issue_kind, account_label, reference;
$$;


-- ----------------------------------------------------------------------------
-- 7. Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean)',
    'public.ledger_data_quality(timestamptz, timestamptz, uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
declare
  v_n integer;
  f   text;
begin
  select count(*) into v_n from public.ledger_mapping_rules
  where business_id is null and marketplace_code = 'NOON' and status = 'ACTIVE';
  if v_n <> 61 then
    raise exception 'Expected 61 active noon import rules, found %.', v_n;
  end if;

  select count(*) into v_n from public.classification_rules
  where business_id is null and marketplace_code = 'NOON' and status = 'ACTIVE';
  if v_n <> 61 then
    raise exception 'Expected 61 active noon classification rules, found %.', v_n;
  end if;

  select count(*) into v_n
  from public.ledger_mapping_rules m
  where m.business_id is null and m.status = 'ACTIVE' and m.marketplace_code = 'NOON'
    and not exists (
      select 1 from public.classification_rules c
      where c.business_id is null and c.status = 'ACTIVE' and c.marketplace_code = 'NOON'
        and c.format_id = m.format_id and c.match_key = m.match_key);
  if v_n <> 0 then
    raise exception '% noon import code(s) have no classification rule.', v_n;
  end if;

  if (select adapter_status from public.marketplaces where code = 'NOON') <> 'AVAILABLE' then
    raise exception 'NOON is not marked AVAILABLE.';
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'source_rows_row_hash_idx') then
    raise exception 'The row fingerprint index is missing.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ledger_apply_file'
      and position('This file repeats' in p.prosrc) > 0
  ) or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'ledger_file_restore'
      and position('rows are already counted' in p.prosrc) > 0
  ) then
    raise exception 'The overlap checks are not in place.';
  end if;

  foreach f in array array['pnl_summary', 'ledger_data_quality']
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = f) <> 1 then
      raise exception 'Exactly one %() must exist.', f;
    end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
  end loop;

  raise notice 'Migration 0034 verified: noon available with 61 rules, overlap checks in place, readers invoker.';
end;
$$;


commit;
