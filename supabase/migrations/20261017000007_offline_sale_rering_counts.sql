-- two-mode Plan 02d, review finding F12 (part A): one definition of "a paid re-ring counts".
--
-- offline_sale_rering_counts(sale, payment) is true when the payment is a re-ring payment for the sale:
--   * not a refund row, not deleted, idempotency key is the canonical rering_<sale id>_ shape;
--   * processed_by is the actor of an offline_sale.rering_approved row for the sale, and it was processed
--     after the earliest such approval;
--   * its tab is not fully refunded: net of non-deleted payments (refunds are negative is_refund rows,
--     reopened_void positives are excluded) is > 0, OR the tab was reopened and is still open (it will be
--     paid again through process_payment_atomic, which the checkout guard never sees).
-- The checkout guard (000008) and resolve_offline_sale (000009) both call it. Helper only.

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
            OR (EXISTS (SELECT 1 FROM public.tabs t WHERE t.id = p.tab_id AND t.status = 'open')
                AND EXISTS (SELECT 1 FROM public.payments r
                             WHERE r.tab_id = p.tab_id AND NOT r.is_deleted AND r.status = 'reopened_void')))
  );
$$;

REVOKE ALL ON FUNCTION public.offline_sale_rering_counts(uuid, uuid) FROM PUBLIC, anon, authenticated;
