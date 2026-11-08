-- two-mode Plan 02d follow-up: a soft-deleted reopened-open re-ring tab never counts as a paid re-ring.
-- Whole redefinition of offline_sale_rering_counts from 20261017000007 plus AND NOT t.is_deleted.

CREATE OR REPLACE FUNCTION public.offline_sale_rering_counts(p_sale_id uuid, p_payment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
     WHERE p.id = p_payment_id AND NOT p.is_refund AND NOT p.is_deleted
       AND p.idempotency_key LIKE ('rering\_' || p_sale_id::text || '\_%')
       AND p.processed_at > (SELECT min(a.created_at) FROM public.audit_logs a
                              WHERE a.entity_type = 'offline_sale' AND a.entity_id = p_sale_id
                                AND a.action = 'offline_sale.rering_approved')
       AND EXISTS (SELECT 1 FROM public.audit_logs ap
                    WHERE ap.entity_type = 'offline_sale' AND ap.entity_id = p_sale_id
                      AND ap.action = 'offline_sale.rering_approved' AND ap.actor_id = p.processed_by)
       AND ((SELECT COALESCE(sum(q.amount), 0) FROM public.payments q
              WHERE q.tab_id = p.tab_id AND NOT q.is_deleted AND (q.is_refund OR q.status IS DISTINCT FROM 'reopened_void')) > 0
            OR (EXISTS (SELECT 1 FROM public.tabs t WHERE t.id = p.tab_id AND t.status = 'open' AND NOT t.is_deleted)
                AND EXISTS (SELECT 1 FROM public.payments r
                             WHERE r.tab_id = p.tab_id AND NOT r.is_deleted AND r.status = 'reopened_void')))
  );
$$;

REVOKE ALL ON FUNCTION public.offline_sale_rering_counts(uuid, uuid) FROM PUBLIC, anon, authenticated;
