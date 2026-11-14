-- Phase 04 Plan 01: closes D-02/D-04 by removing the obsolete modifier popularity RPC.
-- DOWN: manually recreate from 20260721000003_modifier_popularity_rpc.sql if ever needed.
-- Re-creation is not recommended: historical modifier-attach data must be re-derived.

BEGIN;

DROP FUNCTION IF EXISTS get_modifier_popularity_report(timestamptz, timestamptz);

COMMIT;

NOTIFY pgrst, 'reload schema';
