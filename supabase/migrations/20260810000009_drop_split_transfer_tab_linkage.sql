-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 11 Task 2: [BLOCKING] destructive drop of the
-- split-tab (splitting a shared bar tab by seat/item/amount/evenly) and
-- transfer-tab (pure pool-table concept) features. Neither splitting a
-- shared tab by seat nor transferring a tab between tables has a grocery
-- equivalent (D-09).
--
-- Paired follow-up to Plan 11 Task 1, which deleted every src/ file that
-- read/wrote this schema (features/split-tab, features/transfer-tab,
-- pages/pos, widgets/OrderPanel, shared/ui/PersonCard, shared/ui/SubTabColumn,
-- shared/lib/split-math.ts, entities/tab's useSubTabs, and the transfer_tab
-- AI agent tool). refunds/refund_items/payments.is_refund/refund_id
-- (process-refund, D-09) and split-payment (multi-tender, process-payment)
-- are UNCHANGED — both are surgically separated below from the split-tab
-- schema they happen to share a historical migration file with.
--
-- Live-DB introspection performed before authoring this migration (per the
-- phase's documented pool_tables->resources fragility precedent, matching
-- Plan 06's payment-RPC finding and Plan 10's create_order_with_items
-- finding):
--   - pg_proc scan for functions referencing parent_tab_id/split_mode/
--     split_label/tab_transfers turned up 6 functions: split_tab_by_item,
--     split_tab_by_amount, split_tab_by_person, split_tab_evenly (NOT named
--     in this plan's <read_first> — the plan only named by_item/by_person/
--     by_amount and missed the 4th, "Evenly" mode's RPC), transfer_tab, and
--     check_parent_tab_auto_close.
--   - CRITICAL: check_parent_tab_auto_close is the function backing trigger
--     after_payment_insert_check_parent_close, which fires AFTER INSERT ON
--     public.payments FOR EACH ROW — i.e. on every single payment in the
--     app, not just split-tab payments. Its body SELECTs tabs.parent_tab_id
--     unconditionally. A plain DROP COLUMN on tabs.parent_tab_id without
--     first dropping this trigger would break every real checkout on the
--     new project the moment a payment was inserted — exactly the class of
--     break 01-06-SUMMARY.md documented for process_payment_atomic and
--     01-10 documented for create_order_with_items. Dropped outright below
--     (not redefined) since the trigger's entire purpose is split-tab
--     parent/sub-tab auto-close; nothing else it does needs preserving.
--   - process_payment_atomic references the string "split_tab_evenly" only
--     inside a SQL comment ("Subtotal from line items ... same basis as
--     split_tab_evenly") — not a functional call (no PERFORM/SELECT of the
--     function). No redefinition needed for that RPC.
--   - reopen_tab references the string 'split' only inside a comment
--     explaining its reopenable-status guard (`v_status NOT IN ('closed',
--     'paid')` already naturally excludes 'split' without referencing the
--     literal) — no functional change needed.
--   - tab_transfers has no incoming FK from any other table (only
--     tab_transfers_tab_id_fkey -> tabs); dropping it is fully self-
--     contained. Neither tab_transfers nor tabs is a member of the
--     supabase_realtime publication (0 rows from pg_publication_tables) —
--     no ALTER PUBLICATION needed.
--   - tabs.split_mode's CHECK constraint (tabs_split_mode_check), the
--     partial index idx_tabs_parent_tab_id, and the self-referencing FK
--     tabs_parent_tab_id_fkey all drop automatically with their owning
--     column via DROP COLUMN — no explicit DROP CONSTRAINT/INDEX needed for
--     those three.
--   - closed_at_requires_closed_status's live definition is
--     `CHECK (closed_at IS NULL AND status = ANY (ARRAY['open','split']) OR
--     closed_at IS NOT NULL AND status = ANY (ARRAY['closed','paid',
--     'voided']))` — restored below to its pre-split shape (drops 'split'
--     from the open-side array). The 'split' value itself is NOT removed
--     from the tab_status enum (Postgres has no direct DROP VALUE for
--     enums) — it becomes permanently-unreachable dead weight, matching
--     this migration's own read_first note; no code path can ever produce
--     it again once split_tab_by_* is gone.
-- =============================================================================

-- UP:
BEGIN;

-- -----------------------------------------------------------------------
-- 1. Drop the parent-auto-close trigger + function BEFORE dropping
--    tabs.parent_tab_id — this trigger fires on every payment insert.
-- -----------------------------------------------------------------------
DROP TRIGGER IF EXISTS after_payment_insert_check_parent_close ON public.payments;
DROP FUNCTION IF EXISTS public.check_parent_tab_auto_close() CASCADE;

-- -----------------------------------------------------------------------
-- 2. Drop transfer_tab RPC and its audit-trail table.
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.transfer_tab(uuid, uuid, uuid, integer, text, text, text) CASCADE;
DROP TABLE IF EXISTS public.tab_transfers CASCADE;

-- -----------------------------------------------------------------------
-- 3. Drop split_tab RPCs (all 4 modes: item, amount, person, evenly).
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.split_tab_by_item(uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.split_tab_by_amount(uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.split_tab_by_person(uuid, integer, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.split_tab_evenly(uuid, integer) CASCADE;

-- -----------------------------------------------------------------------
-- 4. Restore closed_at_requires_closed_status to its pre-split shape
--    (drops the now-unreachable 'split' status from the open-side array).
-- -----------------------------------------------------------------------
ALTER TABLE public.tabs DROP CONSTRAINT IF EXISTS closed_at_requires_closed_status;
ALTER TABLE public.tabs ADD CONSTRAINT closed_at_requires_closed_status
  CHECK (
    (closed_at IS NULL AND status = 'open')
    OR (closed_at IS NOT NULL AND status IN ('closed', 'paid', 'voided'))
  );

-- -----------------------------------------------------------------------
-- 5. Drop split-linkage columns from tabs. tabs_split_mode_check,
--    idx_tabs_parent_tab_id, and tabs_parent_tab_id_fkey all drop
--    automatically with their owning column.
-- -----------------------------------------------------------------------
ALTER TABLE public.tabs
  DROP COLUMN IF EXISTS parent_tab_id,
  DROP COLUMN IF EXISTS split_mode,
  DROP COLUMN IF EXISTS split_label;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN:
-- BEGIN;
--
-- ALTER TABLE public.tabs
--   ADD COLUMN parent_tab_id uuid NULL REFERENCES public.tabs(id) ON DELETE RESTRICT,
--   ADD COLUMN split_mode text NULL,
--   ADD COLUMN split_label text NULL;
--
-- ALTER TABLE public.tabs ADD CONSTRAINT tabs_split_mode_check
--   CHECK (split_mode = ANY (ARRAY['item'::text, 'evenly'::text, 'by_person'::text, 'by_amount'::text]));
--
-- CREATE INDEX idx_tabs_parent_tab_id ON public.tabs (parent_tab_id) WHERE parent_tab_id IS NOT NULL;
--
-- ALTER TABLE public.tabs DROP CONSTRAINT IF EXISTS closed_at_requires_closed_status;
-- ALTER TABLE public.tabs ADD CONSTRAINT closed_at_requires_closed_status
--   CHECK (
--     (closed_at IS NULL AND status = ANY (ARRAY['open'::tab_status, 'split'::tab_status]))
--     OR (closed_at IS NOT NULL AND status = ANY (ARRAY['closed'::tab_status, 'paid'::tab_status, 'voided'::tab_status]))
--   );
--
-- CREATE TABLE public.tab_transfers (
--   id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   tab_id          uuid NOT NULL REFERENCES public.tabs(id),
--   transferred_at  timestamptz NOT NULL DEFAULT now(),
--   transferred_by  uuid NOT NULL REFERENCES public.profiles(id),
--   from_staff_id   uuid NULL REFERENCES public.profiles(id),
--   to_staff_id     uuid NULL REFERENCES public.profiles(id),
--   from_table      integer NULL,
--   to_table        integer NULL,
--   reason          text NULL,
--   transfer_type   text NOT NULL DEFAULT 'manual'
--     CHECK (transfer_type IN ('staff', 'table', 'pool_to_dining', 'dining_to_pool', 'pool_to_pool', 'manual'))
-- );
--
-- ALTER TABLE public.tab_transfers ENABLE ROW LEVEL SECURITY;
--
-- -- No data restoration, no function/trigger bodies restored — shape only,
-- -- matching this repo's DROP-migration DOWN convention (D-19).
--
-- COMMIT;
-- =============================================================================
