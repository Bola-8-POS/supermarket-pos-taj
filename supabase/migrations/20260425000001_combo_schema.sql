-- =============================================================================
-- S2-01: Combo tables — combo_slots, combo_slot_options, combo_availability
-- =============================================================================

-- UP: combo_slots, combo_slot_options, combo_availability tables
BEGIN;

CREATE TABLE IF NOT EXISTS combo_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label         text NOT NULL,
  slot_type     text NOT NULL CHECK (slot_type IN ('product', 'pool_time')),
  min_qty       integer NOT NULL DEFAULT 1,
  max_qty       integer NOT NULL DEFAULT 1,
  is_required   boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT combo_slots_min_max_check CHECK (min_qty >= 1 AND max_qty >= min_qty)
);

CREATE INDEX idx_combo_slots_combo_product_id ON combo_slots(combo_product_id);
CREATE INDEX idx_combo_slots_sort_order ON combo_slots(sort_order);

CREATE TABLE IF NOT EXISTS combo_slot_options (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_slot_id   uuid NOT NULL REFERENCES combo_slots(id) ON DELETE CASCADE,
  child_product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  prepaid_minutes integer,  -- populated when slot_type='pool_time'
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_combo_slot_options_combo_slot_id ON combo_slot_options(combo_slot_id);
CREATE INDEX idx_combo_slot_options_child_product_id ON combo_slot_options(child_product_id);

CREATE TABLE IF NOT EXISTS combo_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  days_of_week  integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',  -- ISO 1=Mon, 7=Sun
  start_time    time,    -- null = all day
  end_time      time,    -- null = all day
  start_date    date,    -- null = no date restriction
  end_date      date,    -- null = no date restriction
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_combo_availability_combo_product_id ON combo_availability(combo_product_id);

-- RLS: all authenticated can SELECT; manager+admin can INSERT/UPDATE/DELETE
ALTER TABLE combo_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_slot_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE combo_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_auth_select_combo_slots" ON combo_slots
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "manager_admin_write_combo_slots" ON combo_slots
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' IN ('manager', 'admin'))
  WITH CHECK (auth.jwt() ->> 'role' IN ('manager', 'admin'));

CREATE POLICY "all_auth_select_combo_slot_options" ON combo_slot_options
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "manager_admin_write_combo_slot_options" ON combo_slot_options
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' IN ('manager', 'admin'))
  WITH CHECK (auth.jwt() ->> 'role' IN ('manager', 'admin'));

CREATE POLICY "all_auth_select_combo_availability" ON combo_availability
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "manager_admin_write_combo_availability" ON combo_availability
  FOR ALL TO authenticated
  USING (auth.jwt() ->> 'role' IN ('manager', 'admin'))
  WITH CHECK (auth.jwt() ->> 'role' IN ('manager', 'admin'));

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS combo_availability;
-- DROP TABLE IF EXISTS combo_slot_options;
-- DROP TABLE IF EXISTS combo_slots;
-- COMMIT;
-- =============================================================================
