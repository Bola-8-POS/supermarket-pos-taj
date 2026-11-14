-- Migration: waitlist_notifications audit table + RLS + index
-- Phase 7: Waitlist + WhatsApp
-- Idempotent: IF NOT EXISTS / OR REPLACE guards throughout

CREATE TABLE IF NOT EXISTS public.waitlist_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_entry_id   uuid NOT NULL REFERENCES public.waitlist_entries(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'manager')),
  status              text NOT NULL CHECK (status IN ('sent', 'failed', 'pending')),
  provider_message_id text NULL,
  error               text NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.waitlist_notifications ENABLE ROW LEVEL SECURITY;

-- Manager+ can read notification history
CREATE POLICY "waitlist_notifications_select_manager" ON public.waitlist_notifications
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('manager', 'admin'));

-- Service role only for INSERT (edge function uses service role key)
-- No client-side INSERT policy — edge function bypasses RLS via service role

-- Index for per-entry notification history lookup
CREATE INDEX IF NOT EXISTS waitlist_notifications_entry_idx
  ON public.waitlist_notifications (waitlist_entry_id);

-- DOWN:
-- BEGIN;
-- DROP TABLE IF EXISTS waitlist_notifications CASCADE;
-- COMMIT;
