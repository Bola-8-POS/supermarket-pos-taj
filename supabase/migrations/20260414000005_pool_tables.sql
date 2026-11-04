-- =====================================================
-- POOL TABLES & SESSIONS
-- =====================================================

-- Pool Tables
CREATE TABLE pool_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number INT NOT NULL UNIQUE,
  label VARCHAR(50) NOT NULL,
  rate_per_hour NUMERIC(10, 2) NOT NULL,
  status pool_table_status NOT NULL DEFAULT 'available',
  current_session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT number_positive CHECK (number > 0),
  CONSTRAINT rate_positive CHECK (rate_per_hour > 0)
);

CREATE INDEX idx_pool_tables_number ON pool_tables(number);
CREATE INDEX idx_pool_tables_status ON pool_tables(status);
CREATE INDEX idx_pool_tables_current_session_id ON pool_tables(current_session_id) WHERE current_session_id IS NOT NULL;

-- Pool Sessions
CREATE TABLE pool_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES pool_tables(id) ON DELETE RESTRICT,
  tab_id UUID REFERENCES tabs(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  billed_minutes INT,
  total_charge NUMERIC(10, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stopped_at_after_started_at CHECK (stopped_at IS NULL OR stopped_at > started_at),
  CONSTRAINT billed_minutes_requires_stopped_at CHECK (billed_minutes IS NULL OR stopped_at IS NOT NULL),
  CONSTRAINT total_charge_requires_stopped_at CHECK (total_charge IS NULL OR stopped_at IS NOT NULL),
  CONSTRAINT billed_minutes_non_negative CHECK (billed_minutes IS NULL OR billed_minutes >= 0),
  CONSTRAINT total_charge_non_negative CHECK (total_charge IS NULL OR total_charge >= 0)
);

CREATE INDEX idx_pool_sessions_table_id ON pool_sessions(table_id);
CREATE INDEX idx_pool_sessions_tab_id ON pool_sessions(tab_id);
CREATE INDEX idx_pool_sessions_started_at ON pool_sessions(started_at DESC);
CREATE INDEX idx_pool_sessions_active ON pool_sessions(table_id, started_at) WHERE stopped_at IS NULL;

-- Add FK constraint from pool_tables to pool_sessions
ALTER TABLE pool_tables
  ADD CONSTRAINT fk_pool_tables_current_session
  FOREIGN KEY (current_session_id) REFERENCES pool_sessions(id) ON DELETE SET NULL;
