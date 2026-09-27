-- Add email column to profiles so the auth flow can sign in with the correct email
-- Staff email is stored here so we don't need to guess/derive it
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- Index for email lookup
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
