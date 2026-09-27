ALTER TABLE pool_sessions
  ADD COLUMN IF NOT EXISTS previous_table_id UUID REFERENCES pool_tables(id);
