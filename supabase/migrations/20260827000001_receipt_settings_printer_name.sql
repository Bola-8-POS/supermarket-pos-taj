-- Fix: Hardware Settings had no way to select/configure a receipt printer.
-- src-tauri/src/commands/printer.rs's receipt_printer_name() (Phase 19,
-- Plan 19-02) sent a hardcoded "RECEIPT_PRINTER" placeholder for every
-- print/cash-drawer/test-print job, deferred to "Plan 19-06" in that plan's
-- own comment — but 19-06 shipped the audit GET /jobs list API instead, and
-- no later plan closed the gap. On real hardware this only works if the
-- installed printer happens to be named exactly "RECEIPT_PRINTER".
--
-- Adds a nullable printer_name column to the receipt_settings singleton
-- (D-04) so Hardware Settings can persist a chosen printer name; null means
-- "not configured yet", and the Rust command layer's resolve_printer_name()
-- falls back to the same "RECEIPT_PRINTER" sentinel when null/empty, so
-- existing installs keep their current (already-broken-if-unrenamed)
-- behavior rather than a silent behavior change.

BEGIN;

ALTER TABLE receipt_settings ADD COLUMN printer_name TEXT;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- DOWN (not executed automatically — this repo's migrations have no
-- automated rollback mechanism; kept for documentation per CLAUDE.md's
-- Migration DOWN scripts convention):
-- BEGIN;
-- ALTER TABLE receipt_settings DROP COLUMN printer_name;
-- COMMIT;
