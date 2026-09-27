-- Settings restore as one transactional, admin-gated RPC.
--
-- Replaces settings-restore/index.ts's own five upsert/delete steps (two of
-- them today running with their error unchecked, at index.ts:117 and
-- :135-141) with a single definer RPC that reads the snapshot itself (FOR
-- UPDATE, which also serializes two concurrent restores of the same backup)
-- and rolls back completely on any failure.
--
-- Takes the backup id, not a caller-supplied snapshot -- passing both would
-- let them disagree about which backup is actually being restored.

CREATE FUNCTION public.settings_restore_snapshot(p_backup_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_snap jsonb;
  v_tbl  text;
  v_cols text;
  v_vals text;
  v_set  text;
BEGIN
  -- The edge function calls as service_role, so auth.uid() is NULL here --
  -- the caller is checked against the actor id it supplies instead (2c's
  -- NULL-guard shape, active_caller_gates.sql:21-24, adapted to a single
  -- role and to p_actor).
  SELECT role INTO v_role FROM profiles WHERE id = p_actor AND is_active = true;
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'FORBIDDEN: admin access required';
  END IF;

  SELECT snapshot INTO v_snap FROM settings_backups WHERE id = p_backup_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: backup not found';
  END IF;

  -- Column-list strategy: the column list, existing-row/default expression
  -- and ON CONFLICT SET clause are all derived from the catalog,
  -- not hand-maintained, so a column added to one of these tables after this
  -- migration ships is picked up automatically.
  FOREACH v_tbl IN ARRAY ARRAY['categories', 'modifiers', 'products'] LOOP   -- FK order
    SELECT
      string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum),
      string_agg(
        CASE WHEN d.adbin IS NULL THEN format('x.%I', a.attname)
             -- new id AND key absent from the snapshot -> the column's own DEFAULT
             ELSE format('CASE WHEN e.id IS NULL AND NOT (s.r ? %L) THEN %s ELSE x.%I END',
                         a.attname, pg_get_expr(d.adbin, d.adrelid), a.attname)
        END, ', ' ORDER BY a.attnum),
      string_agg(format('%I = EXCLUDED.%I', a.attname, a.attname), ', ' ORDER BY a.attnum)
        FILTER (WHERE a.attname <> 'id')
    INTO v_cols, v_vals, v_set
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = format('public.%I', v_tbl)::regclass
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';

    EXECUTE format($q$
      INSERT INTO public.%1$I (%2$s)
      SELECT %3$s
      FROM jsonb_array_elements($1) AS s(r)
      LEFT JOIN public.%1$I AS e ON e.id = (s.r->>'id')::uuid
      CROSS JOIN LATERAL jsonb_populate_record(e, s.r) AS x   -- e = existing row, or NULL for a new id
      ON CONFLICT (id) DO UPDATE SET %4$s
    $q$, v_tbl, v_cols, v_vals, v_set)
    USING COALESCE(v_snap -> v_tbl, '[]'::jsonb);
  END LOOP;

  -- No merge semantics needed for the link table -- a row has no other
  -- columns to preserve. Today's unchecked delete
  -- (settings-restore/index.ts:117) becomes a checked, transactional step.
  -- The always-true filter satisfies safeupdate (loaded for the
  -- authenticator role this RPC runs under) requiring a WHERE clause on
  -- DELETE, same convention as the edge function's prior
  -- .neq('product_id', '00000000-...') call.
  DELETE FROM product_modifiers WHERE product_id <> '00000000-0000-0000-0000-000000000000';
  INSERT INTO product_modifiers (product_id, modifier_id)
  SELECT (r ->> 'product_id')::uuid, (r ->> 'modifier_id')::uuid
  FROM jsonb_array_elements(COALESCE(v_snap -> 'product_modifiers', '[]'::jsonb)) AS r;

  -- Allow-listed settings keys only (verbatim against domain.ts's
  -- SettingsKeySchema); updated_by = the actor this RPC verified above --
  -- the edge function has no caller identity of its own once it calls in as
  -- service_role, unlike today's index.ts:129, which used the caller's id.
  INSERT INTO settings (key, value, updated_by)
  SELECT r ->> 'key', r -> 'value', p_actor
  FROM jsonb_array_elements(COALESCE(v_snap -> 'settings', '[]'::jsonb)) AS r
  WHERE r ->> 'key' IN ('general', 'billing', 'email_receipts', 'pool_tables', 'receipt', 'payment_labels', 'near_expiry')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  -- Today's unchecked update (settings-restore/index.ts:135-141) becomes
  -- part of this same transaction -- a failure above rolls this back too.
  UPDATE settings_backups
  SET restored_at = now(), restored_by = p_actor
  WHERE id = p_backup_id;
END;
$$;

REVOKE ALL ON FUNCTION public.settings_restore_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settings_restore_snapshot(uuid, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
