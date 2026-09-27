-- =============================================================================
-- S1-02: Hierarchical categories with depth-3 check and cycle rejection
-- =============================================================================

BEGIN;

-- 1. Add parent_id column (nullable FK, self-reference)
ALTER TABLE categories
  ADD COLUMN parent_id uuid NULL REFERENCES categories(id) ON DELETE RESTRICT;

CREATE INDEX idx_categories_parent_id ON categories(parent_id);

-- 2. Depth-3 check + cycle rejection trigger
--    Fires on INSERT or on UPDATE that changes parent_id.
--    Depth is counted as ancestors from NEW.parent_id upward:
--      depth=1 means NEW.parent_id is a root → NEW would be depth-2 (child).
--      depth=2 means NEW.parent_id is a child → NEW would be depth-3 (grandchild).
--      depth=3 means that parent is already a grandchild → reject (would be depth-4).
CREATE OR REPLACE FUNCTION categories_depth_check()
RETURNS TRIGGER AS $$
DECLARE
  ancestor_depth int;
BEGIN
  -- Root category: no parent, always allowed.
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Cycle check: walk upward from NEW.parent_id; if NEW.id appears, it's a cycle.
  -- On INSERT, NEW.id is not yet in the table so this only matters for UPDATE.
  IF EXISTS (
    WITH RECURSIVE walk AS (
      SELECT NEW.parent_id AS id
      UNION ALL
      SELECT c.parent_id
      FROM categories c
      JOIN walk w ON c.id = w.id
      WHERE c.parent_id IS NOT NULL
    )
    SELECT 1 FROM walk WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Category cycle detected: % would become its own ancestor', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Depth check: count how many ancestors NEW.parent_id has (including itself).
  --   Result 0 = parent is root  → NEW is depth 2 (child)   — OK
  --   Result 1 = parent is child → NEW is depth 3 (grandchild) — OK
  --   Result 2 = parent is grandchild → NEW would be depth 4  — REJECT
  WITH RECURSIVE ancestry AS (
    SELECT id, parent_id, 1 AS d
    FROM categories
    WHERE id = NEW.parent_id
    UNION ALL
    SELECT c.id, c.parent_id, a.d + 1
    FROM categories c
    JOIN ancestry a ON c.id = a.parent_id
    WHERE a.d < 10 -- hard safety bound against runaway recursion
  )
  SELECT COALESCE(MAX(d), 0) INTO ancestor_depth FROM ancestry;

  IF ancestor_depth >= 3 THEN
    RAISE EXCEPTION 'Category nesting too deep: maximum allowed depth is 3, parent is already at depth %', ancestor_depth
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER categories_depth_check_trg
  BEFORE INSERT OR UPDATE OF parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION categories_depth_check();

COMMIT;

-- =============================================================================
-- DOWN:
-- BEGIN;
-- DROP TRIGGER IF EXISTS categories_depth_check_trg ON categories;
-- DROP FUNCTION IF EXISTS categories_depth_check();
-- DROP INDEX IF EXISTS idx_categories_parent_id;
-- ALTER TABLE categories DROP COLUMN IF EXISTS parent_id;
-- COMMIT;
-- =============================================================================
