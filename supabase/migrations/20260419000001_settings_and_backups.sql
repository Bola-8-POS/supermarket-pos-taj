-- =====================================================
-- SETTINGS & BACKUP HISTORY
-- =====================================================

CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

CREATE INDEX idx_settings_key ON settings(key);
CREATE INDEX idx_settings_updated_at ON settings(updated_at DESC);

CREATE TABLE settings_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label VARCHAR(120) NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id),
  restored_at TIMESTAMPTZ,
  restored_by UUID REFERENCES profiles(id)
);

CREATE INDEX idx_settings_backups_created_at ON settings_backups(created_at DESC);

CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings_backups ENABLE ROW LEVEL SECURITY;

-- Managers can read and update billing-only settings keys.
-- Admins can read and update any settings key.
CREATE POLICY "settings_select_manager_admin" ON settings
  FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

CREATE POLICY "settings_insert_manager_admin_scoped" ON settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      get_user_role() = 'admin'
    ) OR (
      get_user_role() = 'manager'
      AND key IN ('billing', 'pool_tables')
    )
  );

CREATE POLICY "settings_update_manager_admin_scoped" ON settings
  FOR UPDATE
  TO authenticated
  USING (
    (
      get_user_role() = 'admin'
    ) OR (
      get_user_role() = 'manager'
      AND key IN ('billing', 'pool_tables')
    )
  )
  WITH CHECK (
    (
      get_user_role() = 'admin'
    ) OR (
      get_user_role() = 'manager'
      AND key IN ('billing', 'pool_tables')
    )
  );

-- Only admins can keep backup snapshots and perform restore audits.
CREATE POLICY "settings_backups_select_admin" ON settings_backups
  FOR SELECT
  TO authenticated
  USING (get_user_role() = 'admin');

CREATE POLICY "settings_backups_insert_admin" ON settings_backups
  FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "settings_backups_update_admin" ON settings_backups
  FOR UPDATE
  TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');
