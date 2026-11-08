-- =============================================================================
-- S1-03: Modifier group tables (modifier_groups, modifier_group_items, product_modifier_groups)
-- The existing modifiers + product_modifiers tables remain unchanged.
-- =============================================================================

BEGIN;

-- 1. modifier_groups: defines a named group with cardinality rules
CREATE TABLE modifier_groups (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  min_select   int         NOT NULL DEFAULT 0,
  max_select   int         NOT NULL DEFAULT 1,
  is_required  boolean     NOT NULL DEFAULT false,
  sort_order   int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT modifier_groups_cardinality_check
    CHECK (min_select >= 0 AND max_select >= min_select)
);

CREATE INDEX idx_modifier_groups_sort_order ON modifier_groups(sort_order);

-- Apply updated_at trigger (reuse the existing function from migration 20260414000008)
CREATE TRIGGER update_modifier_groups_updated_at
  BEFORE UPDATE ON modifier_groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. modifier_group_items: links individual modifiers into a group (M:N)
CREATE TABLE modifier_group_items (
  group_id    uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  modifier_id uuid NOT NULL REFERENCES modifiers(id)       ON DELETE CASCADE,
  sort_order  int  NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, modifier_id)
);

CREATE INDEX idx_modifier_group_items_modifier_id ON modifier_group_items(modifier_id);

-- 3. product_modifier_groups: links products to modifier groups (M:N)
CREATE TABLE product_modifier_groups (
  product_id uuid    NOT NULL REFERENCES products(id)        ON DELETE CASCADE,
  group_id   uuid    NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort_order int,
  PRIMARY KEY (product_id, group_id)
);

CREATE INDEX idx_product_modifier_groups_group_id ON product_modifier_groups(group_id);

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS product_modifier_groups;
-- DROP TABLE IF EXISTS modifier_group_items;
-- DROP TRIGGER IF EXISTS update_modifier_groups_updated_at ON modifier_groups;
-- DROP TABLE IF EXISTS modifier_groups;
-- COMMIT;
-- =============================================================================
