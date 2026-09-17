-- ============================================================================
-- Rollback for 0033  The ledger dashboard's readers
-- ============================================================================
-- Removes the two readers 0033 added. The recreated ledger_data_quality() is
-- left in place: it accepts every call the 0032 version accepted (the new
-- business filter is optional) and only adds a column, so nothing depends on
-- the old shape. Nothing here touches data.
-- ============================================================================

begin;

drop function if exists public.pnl_settlements(timestamptz, timestamptz, uuid);
drop function if exists public.pnl_periods(uuid);

commit;
