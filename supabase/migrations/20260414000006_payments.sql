-- =====================================================
-- PAYMENTS
-- =====================================================

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tab_id UUID NOT NULL UNIQUE REFERENCES tabs(id) ON DELETE RESTRICT,
  amount NUMERIC(10, 2) NOT NULL,
  tip_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  method payment_method NOT NULL,
  square_payment_id VARCHAR(255),
  square_receipt_url TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_by UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT amount_positive CHECK (amount > 0),
  CONSTRAINT tip_amount_non_negative CHECK (tip_amount >= 0),
  CONSTRAINT square_payment_id_unique UNIQUE (square_payment_id)
);

CREATE INDEX idx_payments_tab_id ON payments(tab_id);
CREATE INDEX idx_payments_processed_by ON payments(processed_by);
CREATE INDEX idx_payments_processed_at ON payments(processed_at DESC);
CREATE INDEX idx_payments_method ON payments(method);
CREATE INDEX idx_payments_square_payment_id ON payments(square_payment_id) WHERE square_payment_id IS NOT NULL;
