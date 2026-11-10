-- Migration: trigger function + trigger for prep_productions
-- Fires AFTER INSERT ON prep_productions FOR EACH ROW
-- SECURITY DEFINER so record_stock_movement runs with correct auth context

CREATE OR REPLACE FUNCTION fn_prep_production_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_prep      boolean;
  v_recipe_id    uuid;
  v_yield_qty    numeric;
  v_delta        numeric;
  v_item         RECORD;
BEGIN
  -- Step 1: Verify is_prep = true on the target ingredient
  SELECT is_prep INTO v_is_prep
    FROM ingredients
   WHERE id = NEW.prep_ingredient_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: ingredient % does not exist', NEW.prep_ingredient_id;
  END IF;

  IF v_is_prep = false THEN
    RAISE EXCEPTION 'PREP_INGREDIENT_REQUIRED: ingredient % is not a prep ingredient', NEW.prep_ingredient_id;
  END IF;

  -- Step 2: Credit the prep ingredient (+qty_produced)
  PERFORM record_stock_movement(
    NEW.prep_ingredient_id,
    NEW.qty_produced,
    'prep_production',
    'prep_production',
    NEW.id,
    NULL
  );

  -- Step 3: Look up recipe for this prep ingredient
  SELECT id, yield_qty INTO v_recipe_id, v_yield_qty
    FROM recipes
   WHERE prep_ingredient_id = NEW.prep_ingredient_id;

  IF NOT FOUND THEN
    -- No recipe yet — prep credit already written; no raw consumption
    RETURN NEW;
  END IF;

  -- Step 4: Consume each raw ingredient listed in the recipe
  FOR v_item IN
    SELECT ingredient_id, qty
      FROM recipe_items
     WHERE recipe_id = v_recipe_id
  LOOP
    v_delta := -(NEW.qty_produced * v_item.qty / v_yield_qty);

    -- Idempotency: catch 23505 (duplicate stock_movement) as no-op
    BEGIN
      PERFORM record_stock_movement(
        v_item.ingredient_id,
        v_delta,
        'prep_consumption',
        'prep_production',
        NEW.id,
        NULL
      );
    EXCEPTION WHEN unique_violation THEN
      -- Already recorded (idempotent retry) — skip
      NULL;
    END;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Create the trigger (drop-and-recreate pattern for idempotency)
DROP TRIGGER IF EXISTS trg_prep_production_insert ON prep_productions;

CREATE TRIGGER trg_prep_production_insert
  AFTER INSERT ON prep_productions
  FOR EACH ROW
  EXECUTE FUNCTION fn_prep_production_insert();
