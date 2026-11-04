-- =============================================================================
-- Phase 1 (01-09): [BLOCKING] Drop combos, recipes, ingredient costing, and
-- modifier-inventory-rule depletion — bar-menu concepts with no grocery
-- equivalent (Phase Boundary).
--
-- Live-DB introspection (pg_proc ILIKE sweep, run this session against the
-- self-hosted stack) confirmed the exact blast radius before authoring this
-- migration:
--   - combo:      add_combo_to_tab, check_combo_slot_option_eligible,
--                 check_combo_slot_option_not_nested, is_combo_available
--                 (all dropped below) + evaluate_promotions_for_item,
--                 process_payment_atomic, split_tab_by_amount/item/person/
--                 evenly (KEPT — see note below, comment/column-only refs)
--   - recipe:     deplete_for_order_item only (rewritten as v6 in the paired
--                 migration, not touched here)
--   - ingredient: create_order_with_items (comment only, untouched),
--                 deplete_for_order_item (rewritten in the paired migration),
--                 record_stock_movement (dropped below — see note)
--   - modifier_inventory_rules: deplete_for_order_item only (rewritten)
--
-- NOT dropped, deliberately (out of this plan's scope — see 01-09-SUMMARY.md
-- deviations for the full reasoning):
--   - products.is_combo / combo_eligible / combo_price_override
--   - order_items.parent_order_item_id / combo_slot_id
--   These columns are read by evaluate_promotions_for_item (combo-exclusion
--   branch) and every split_tab_by_* / process_payment_atomic function
--   (parent_order_item_id filters). Dropping them would require rewriting
--   6 payment/promotions/split-tab RPCs — out of scope for a strip-rebrand
--   plan and far higher risk than leaving 5 permanently-dormant columns
--   (nothing can ever write is_combo=true or a non-null combo_slot_id again
--   once add_combo_to_tab is gone below, so these branches become inert,
--   not broken).
--   - stock_movements table itself (generic, shared ledger reused by
--     transfer-tab audit, edit-paid-tab, and open-units — confirmed via
--     grep across all migrations referencing stock_movements before this
--     migration was authored; only record_stock_movement, which is
--     ingredient-exclusive, is dropped)
--
-- record_stock_movement is dropped as direct fallout: it is a SECURITY
-- DEFINER RPC hard-coded against the `ingredients` table (SELECT ... FROM
-- ingredients ... FOR UPDATE; UPDATE ingredients SET quantity_on_hand ...)
-- and, per the same pg_proc sweep, its only two callers were
-- deplete_for_order_item's recipe/modifier loops (removed by the paired v6
-- migration) and the deleted AdjustStockMovementDialog client feature
-- (01-09 Task 1). Zero callers remain after this migration + the paired v6
-- migration, so it would otherwise become a dangling reference to a table
-- that no longer exists. Its live signature carries a trailing p_terminal_id
-- param added by 20260703000002_wire_transfer_tab_stock_movement_audit.sql
-- (not present in the original 20260426000003 creation migration) — the
-- DROP FUNCTION below must match the current 7-arg signature or it silently
-- no-ops under IF EXISTS.
--
-- Order: drop dependents (trigger functions, views, RPCs) before their
-- tables; drop combo schema and modifier_inventory_rules (leaf, no other
-- table depends on them) before recipes; drop recipes before ingredients
-- (recipes.prep_ingredient_id references ingredients — CASCADE handles
-- either order, but this order matches the dependency direction).
-- =============================================================================

-- UP:
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Combo domain: trigger functions (CASCADE drops their triggers on
--    combo_slot_options), reporting views, RPCs, then tables.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS check_combo_slot_option_not_nested() CASCADE;
DROP FUNCTION IF EXISTS check_combo_slot_option_eligible() CASCADE;

DROP VIEW IF EXISTS combo_mix_daily;
DROP VIEW IF EXISTS product_combo_usage;

DROP FUNCTION IF EXISTS add_combo_to_tab(uuid, uuid, jsonb, boolean, text);
DROP FUNCTION IF EXISTS is_combo_available(uuid, timestamptz);

DROP TABLE IF EXISTS combo_availability CASCADE;
DROP TABLE IF EXISTS combo_slot_options CASCADE;
DROP TABLE IF EXISTS combo_slots CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Modifier-inventory-rule domain (leaf table, no dependents besides the
--    deplete_for_order_item modifier loop removed by the paired migration).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS modifier_inventory_rules CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Ingredient stock-movement RPC (ingredient-exclusive; the generic
--    stock_movements table and its other callers are untouched). Current
--    live signature (7 args, trailing p_terminal_id) — see note above.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_stock_movement(uuid, numeric, text, text, uuid, text, text);

-- ---------------------------------------------------------------------------
-- 4. Recipes (CASCADE drops the recipes_updated_at trigger and the
--    prep_ingredient_id extension column with the table itself — resolves
--    01-07's deferred prep_ingredient_id cleanup). recipe_items is NOT
--    auto-dropped by this CASCADE — DROP TABLE ... CASCADE only removes the
--    FK *constraint* on a referencing table, not the referencing table
--    itself, so recipe_items needs its own explicit DROP.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS recipes CASCADE;
DROP FUNCTION IF EXISTS update_recipes_updated_at();
DROP TABLE IF EXISTS recipe_items CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Ingredients (CASCADE drops recipe_variance_daily, which SELECTs FROM
--    ingredients, and the now-unused stock_movements.ingredient_id FK
--    constraint — the column itself is left in place, generic table).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS ingredients CASCADE;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- DOWN (shape-only — re-derive data from a backup if this is ever unwound):
-- BEGIN;
-- -- Recreate table shapes per their original migrations, then re-run the
-- -- RLS/trigger/RPC bodies from:
-- --   20260426000001_ingredients_table.sql (+ 20260426000011 RLS fix)
-- --   20260428000001_recipes_tables.sql (recipes, recipe_items only —
-- --     audit_log is NOT part of this DOWN, it is a shared kept table)
-- --   20260429000002_recipes_prep_extension.sql
-- --   20260706000002_modifier_inventory_rules_table.sql
-- --     (+ 20260707000002 created_at column)
-- --   20260426000003_record_stock_movement_rpc.sql
-- --   20260424000004_product_combo_flags.sql (products columns only —
-- --     NOT dropped by this migration, already present)
-- --   20260425000001_combo_schema.sql through 20260425000005_add_combo_to_tab_rpc.sql
-- --   20260505000001_s6_reporting_views.sql (combo_mix_daily, recipe_variance_daily only)
-- -- Then reapply deplete_for_order_item v5 per the paired migration's DOWN
-- -- section before any of the above will actually be exercised again.
-- COMMIT;
-- =============================================================================
