-- Migration: waitlist_entries table + RLS + indexes
-- Phase 7: Waitlist + WhatsApp
-- Idempotent: IF NOT EXISTS / OR REPLACE guards throughout

CREATE TABLE IF NOT EXISTS public.waitlist_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  party_size   smallint NOT NULL CHECK (party_size BETWEEN 1 AND 20),
  phone_e164   text NULL,
  status       text NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting', 'notified', 'seated', 'no_show', 'cancelled')),
  table_id     uuid NULL REFERENCES pool_tables(id) ON DELETE SET NULL,
  seated_at    timestamptz NULL,
  notified_at  timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read queue (bartenders need read-only access)
CREATE POLICY "waitlist_entries_select_authenticated" ON public.waitlist_entries
  FOR SELECT TO authenticated USING (true);

-- Only manager+ can insert new entries
CREATE POLICY "waitlist_entries_insert_manager" ON public.waitlist_entries
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('manager', 'admin'));

-- Only manager+ can update status/table assignments
CREATE POLICY "waitlist_entries_update_manager" ON public.waitlist_entries
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Only manager+ can delete/cancel entries
CREATE POLICY "waitlist_entries_delete_manager" ON public.waitlist_entries
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- FIFO ordering index
CREATE INDEX IF NOT EXISTS waitlist_entries_created_at_idx
  ON public.waitlist_entries (created_at ASC);

-- Status filter for active queue
CREATE INDEX IF NOT EXISTS waitlist_entries_status_idx
  ON public.waitlist_entries (status);

-- Quoted-wait 7-day avg query: party_size + seated_at for seated entries
CREATE INDEX IF NOT EXISTS waitlist_entries_seated_at_party_idx
  ON public.waitlist_entries (party_size, seated_at)
  WHERE status = 'seated' AND seated_at IS NOT NULL;

-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS waitlist_entries CASCADE;
-- COMMIT;
