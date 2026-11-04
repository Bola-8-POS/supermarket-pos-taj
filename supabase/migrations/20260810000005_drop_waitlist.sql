-- =============================================================================
-- Phase 1 (strip-rebrand), Plan 08 Task 2: [BLOCKING] destructive drop of the
-- walk-in waitlist queue domain (D-Phase Boundary — a walk-in waitlist has no
-- equivalent for a grocery direct-sale checkout).
--
-- Paired follow-up to Plan 08 Task 1, which deleted every src/ and
-- supabase/functions/ file that read/wrote these tables (the waitlist
-- entity, 5 waitlist lifecycle features, WaitlistQueue/WaitlistAnalyticsReport
-- widgets, the /waitlist page, and the send-waitlist-notification edge
-- function). Nothing in the codebase references waitlist_entries or
-- waitlist_notifications after this migration lands.
--
-- Live-DB introspection performed before authoring this migration (per the
-- phase's documented pool_tables->resources fragility precedent):
--   - waitlist_entries is NOT a member of the supabase_realtime publication
--     (0 rows from pg_publication_tables) — no ALTER PUBLICATION needed,
--     confirming RESEARCH.md Assumption A4's guess that the app relied on
--     the notify trigger's pg_net HTTP call, not table-level Realtime.
--   - Only one FK references these tables: waitlist_notifications_waitlist_entry_id_fkey
--     (waitlist_notifications -> waitlist_entries). The original
--     waitlist_entries.table_id -> pool_tables(id) FK is already gone —
--     dropped as a dangling-constraint side effect of Plan 06's
--     `DROP TABLE resources CASCADE` (pool_tables was renamed to resources
--     before that drop), per 01-06-SUMMARY.md's documented pattern.
--   - Only one function references "waitlist" in pg_proc: notify_waitlist_entry().
--   - Only one trigger: trg_waitlist_notify on waitlist_entries.
--   - waitlist_metrics_daily (a plain VIEW, not materialized, defined in
--     20260505000001_s6_reporting_views.sql) selects FROM waitlist_entries —
--     it is not named in RESEARCH.md's SQL removal table but is explicitly
--     dropped below (would also cascade-drop automatically via
--     `DROP TABLE waitlist_entries CASCADE`, but an explicit DROP VIEW
--     matches this repo's stated preference for explicitness over relying
--     on CASCADE alone).
-- =============================================================================

-- UP:
BEGIN;

DROP TRIGGER IF EXISTS trg_waitlist_notify ON public.waitlist_entries;
DROP FUNCTION IF EXISTS public.notify_waitlist_entry() CASCADE;

DROP VIEW IF EXISTS public.waitlist_metrics_daily;

DROP TABLE IF EXISTS public.waitlist_notifications CASCADE;
DROP TABLE IF EXISTS public.waitlist_entries CASCADE;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- DOWN:
-- BEGIN;
--
-- CREATE TABLE public.waitlist_entries (
--   id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
--   party_size   smallint NOT NULL CHECK (party_size BETWEEN 1 AND 20),
--   phone_e164   text NULL,
--   status       text NOT NULL DEFAULT 'waiting'
--                  CHECK (status IN ('waiting', 'notified', 'seated', 'no_show', 'cancelled')),
--   table_id     uuid NULL,
--   seated_at    timestamptz NULL,
--   notified_at  timestamptz NULL,
--   created_at   timestamptz NOT NULL DEFAULT now()
-- );
--
-- ALTER TABLE public.waitlist_entries ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "waitlist_entries_select_authenticated" ON public.waitlist_entries
--   FOR SELECT TO authenticated USING (true);
-- CREATE POLICY "waitlist_entries_insert_manager" ON public.waitlist_entries
--   FOR INSERT TO authenticated
--   WITH CHECK (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "waitlist_entries_update_manager" ON public.waitlist_entries
--   FOR UPDATE TO authenticated
--   USING (get_user_role() IN ('manager', 'admin'));
-- CREATE POLICY "waitlist_entries_delete_manager" ON public.waitlist_entries
--   FOR DELETE TO authenticated
--   USING (get_user_role() IN ('manager', 'admin'));
--
-- CREATE INDEX waitlist_entries_created_at_idx ON public.waitlist_entries (created_at ASC);
-- CREATE INDEX waitlist_entries_status_idx ON public.waitlist_entries (status);
-- CREATE INDEX waitlist_entries_seated_at_party_idx
--   ON public.waitlist_entries (party_size, seated_at)
--   WHERE status = 'seated' AND seated_at IS NOT NULL;
--
-- CREATE TABLE public.waitlist_notifications (
--   id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   waitlist_entry_id   uuid NOT NULL REFERENCES public.waitlist_entries(id) ON DELETE CASCADE,
--   channel             text NOT NULL CHECK (channel IN ('whatsapp', 'manager')),
--   status              text NOT NULL CHECK (status IN ('sent', 'failed', 'pending')),
--   provider_message_id text NULL,
--   error               text NULL,
--   created_at          timestamptz NOT NULL DEFAULT now()
-- );
--
-- ALTER TABLE public.waitlist_notifications ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "waitlist_notifications_select_manager" ON public.waitlist_notifications
--   FOR SELECT TO authenticated
--   USING (get_user_role() IN ('manager', 'admin'));
--
-- CREATE INDEX waitlist_notifications_entry_idx
--   ON public.waitlist_notifications (waitlist_entry_id);
--
-- -- No data restoration — table shape only, matching repo convention.
-- -- Trigger function/view/RPC bodies not restored — shape only.
--
-- COMMIT;
-- =============================================================================
