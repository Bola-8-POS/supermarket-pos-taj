-- =====================================================
-- PROFILES & SHIFTS
-- =====================================================

-- Profiles (extends auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'bartender',
  pin VARCHAR(6) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pin_length CHECK (LENGTH(pin) = 6),
  CONSTRAINT pin_numeric CHECK (pin ~ '^[0-9]{6}$')
);

CREATE INDEX idx_profiles_role ON profiles(role);
CREATE INDEX idx_profiles_is_active ON profiles(is_active);
CREATE INDEX idx_profiles_pin ON profiles(pin) WHERE is_active = true;

-- Shifts
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clock_out TIMESTAMPTZ,
  opening_cash NUMERIC(10, 2) NOT NULL DEFAULT 0,
  closing_cash NUMERIC(10, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clock_out_after_clock_in CHECK (clock_out IS NULL OR clock_out > clock_in),
  CONSTRAINT closing_cash_requires_clock_out CHECK (closing_cash IS NULL OR clock_out IS NOT NULL)
);

CREATE INDEX idx_shifts_staff_id ON shifts(staff_id);
CREATE INDEX idx_shifts_clock_in ON shifts(clock_in DESC);
CREATE INDEX idx_shifts_active ON shifts(staff_id, clock_in) WHERE clock_out IS NULL;
