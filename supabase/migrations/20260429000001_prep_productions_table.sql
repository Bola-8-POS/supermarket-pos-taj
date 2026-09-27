-- Migration: prep_productions table + RLS + indexes
-- Idempotent: IF NOT EXISTS / OR REPLACE guards throughout

CREATE TABLE IF NOT EXISTS prep_productions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prep_ingredient_id  uuid NOT NULL REFERENCES ingredients(id),
  qty_produced        numeric NOT NULL CHECK (qty_produced > 0),
  notes               text,
  produced_by         uuid REFERENCES profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- No updated_at: prep productions are immutable (append-only ledger)
-- No UPDATE or DELETE policies

ALTER TABLE prep_productions ENABLE ROW LEVEL SECURITY;

-- Authenticated can read all prep productions
CREATE POLICY "prep_productions_select_authenticated" ON prep_productions
  FOR SELECT TO authenticated USING (true);

-- Manager, admin, and kitchen staff can record prep batches
CREATE POLICY "prep_productions_insert_kitchen_manager" ON prep_productions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin', 'kitchen'));

-- Index for listing by prep ingredient (dashboard filter)
CREATE INDEX IF NOT EXISTS idx_prep_productions_prep_ingredient_id
  ON prep_productions (prep_ingredient_id);

-- Index for time-ordered list (newest first in dashboard)
CREATE INDEX IF NOT EXISTS idx_prep_productions_created_at
  ON prep_productions (created_at DESC);
