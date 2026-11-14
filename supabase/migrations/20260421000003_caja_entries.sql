CREATE TABLE caja_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caja_session_id UUID NOT NULL REFERENCES caja_sessions(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  concept         TEXT NOT NULL CHECK (char_length(concept) BETWEEN 1 AND 200),
  staff_id        UUID NOT NULL REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_caja_entries_session ON caja_entries(caja_session_id);

ALTER TABLE caja_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read caja entries" ON caja_entries
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "managers insert caja entries" ON caja_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'))
  );

CREATE POLICY "managers delete caja entries" ON caja_entries
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'))
  );
