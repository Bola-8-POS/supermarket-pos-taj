-- Post-checks for e2e/remote-smoke/synthetic-trading-day.spec.ts. SELECT-only: writes nothing.
-- Run in the Supabase SQL editor (or psql) on the project the spec ran against, after the spec ends.
-- Edit the literal in `params` if E2E_SYNTH_TAG was overridden. Every section returns rows named
-- check / expected / actual / ok; any ok = false is a finding.
-- Tagged data = products whose name starts with the tag (the spec names every product it creates
-- "<tag> ..."), so the checks never touch unrelated store sales.
-- Column and table names verified against src/shared/lib/supabase.types.ts (Row types) and the
-- migrations named in the comments; nothing here is guessed except where a comment says UNVERIFIED.

WITH params AS (SELECT 'E2E-SYNTH-20261103'::text AS tag),

-- products.name: text. Tagged products created by the spec (4: cash, card, weighed, offline).
tagged_products AS (
  SELECT p.id, p.name FROM products p, params WHERE p.name LIKE params.tag || '%'
),

-- order_items.product_id/order_id, orders.tab_id: link a tagged product to the tab it was sold on.
tagged_tabs AS (
  SELECT DISTINCT o.tab_id
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN tagged_products tp ON tp.id = oi.product_id
),

-- payments: amount (negative on refund rows), method (enum payment_method), is_refund, refund_id,
-- approved_by (manager who approved a refund), reference_number, idempotency_key, caja_session_id.
tagged_payments AS (
  SELECT p.* FROM payments p WHERE p.tab_id IN (SELECT tab_id FROM tagged_tabs)
),

-- caja_sessions: status ('open'|'closed'), opening_cash, closing_cash, opened_at, closed_at,
-- cash_reconciliation (jsonb, stored at close: openingCash/cashSales/expectedCash/closingCash/variance).
tagged_sessions AS (
  SELECT cs.* FROM caja_sessions cs
  WHERE cs.id IN (SELECT caja_session_id FROM tagged_payments WHERE caja_session_id IS NOT NULL)
)

-- 1. Payments for the day by method and is_refund (informational, ok = NULL). Expected from the spec:
--    cash / refund=false: 3 rows (cash sale, weighed-promo sale, offline sale); card / refund=false: 1 row;
--    cash / refund=true: 1 row (refund of the cash sale; the refund row keeps the original method,
--    amount negative: process_refund step 8 in 20260925000003).
SELECT '1 payments by method/is_refund' AS check,
       method::text || ' / refund=' || is_refund::text AS expected,
       count(*)::text || ' rows, sum ' || sum(amount)::text AS actual,
       NULL::boolean AS ok
FROM tagged_payments
GROUP BY method, is_refund

UNION ALL
-- 2. Refund row: refunds(original_payment_id, amount, reason, created_by) and the negative
--    payments row with approved_by NOT NULL (process_refund step 8, 20260925000003).
SELECT '2 refund has approved_by',
       'exactly 1 refund payment, approved_by set, refund_id set',
       count(*)::text || ' refund payment(s); with approved_by: ' || count(approved_by)::text
         || '; with refund_id: ' || count(refund_id)::text,
       count(*) = 1 AND count(approved_by) = 1 AND count(refund_id) = 1
FROM tagged_payments WHERE is_refund

UNION ALL
SELECT '2b refunds table row',
       'exactly 1 refunds row for the tagged payments',
       count(*)::text,
       count(*) = 1
FROM refunds r WHERE r.original_payment_id IN (SELECT id FROM tagged_payments WHERE NOT is_refund)

UNION ALL
-- 3. rpc_idempotency (PK idempotency_key; rpc_name; staff_id): one ledger row per sale key.
--    A split sale stores payments keys "<key>-legN", so strip that suffix. Refund rows carry their
--    own key. UNVERIFIED: whether process_direct_sale_atomic itself writes this ledger on the
--    deployed version (migrations 20260929000001-08 are the ledger work); 0 rows = report, not proof of a bug.
SELECT '3 rpc_idempotency per sale key',
       'exactly 1 ledger row per distinct sale key',
       k.sale_key || ' -> ' || count(ri.idempotency_key)::text,
       count(ri.idempotency_key) = 1
FROM (
  SELECT DISTINCT regexp_replace(idempotency_key, '-leg[0-9]+$', '') AS sale_key
  FROM tagged_payments WHERE NOT is_refund
) k
LEFT JOIN rpc_idempotency ri ON ri.idempotency_key = k.sale_key
GROUP BY k.sale_key

UNION ALL
-- 4. audit_logs (action, entity_type, entity_id, created_at): no offline escalation / write-off in
--    the tagged window (first tagged session open .. last close, or now() while still open).
SELECT '4 no offline_sale.escalated / written_off in window',
       '0 rows',
       count(*)::text,
       count(*) = 0
FROM audit_logs a
WHERE a.action IN ('offline_sale.escalated', 'offline_sale.written_off')
  AND a.created_at >= (SELECT min(opened_at) FROM tagged_sessions)
  AND a.created_at <= COALESCE((SELECT max(closed_at) FROM tagged_sessions), now())

UNION ALL
-- 5. Caja closed: every tagged session closed, with a stored reconciliation.
SELECT '5 caja closed',
       'all tagged sessions closed, closing_cash set',
       string_agg(id::text || ':' || status || ':' || COALESCE(closing_cash::text, 'null'), ', '),
       bool_and(status = 'closed' AND closing_cash IS NOT NULL)
FROM tagged_sessions

UNION ALL
-- 6. Balanced caja: stored variance = 0 and recomputed expected cash
--    (opening + signed cash payments attributed to the session + income - expense, entries with
--    source <> 'reopen'; caja_entries: type 'income'|'expense', amount, source) equals closing_cash.
SELECT '6 caja balanced',
       'closing_cash = expected; stored variance = 0',
       'closing ' || ts.closing_cash::text || ' vs expected '
         || (ts.opening_cash
             + COALESCE((SELECT sum(p.amount) FROM payments p
                         WHERE p.caja_session_id = ts.id AND p.method = 'cash'), 0)
             + COALESCE((SELECT sum(e.amount) FROM caja_entries e
                         WHERE e.caja_session_id = ts.id AND e.type = 'income' AND e.source <> 'reopen'), 0)
             - COALESCE((SELECT sum(e.amount) FROM caja_entries e
                         WHERE e.caja_session_id = ts.id AND e.type = 'expense' AND e.source <> 'reopen'), 0))::text
         || '; stored variance ' || COALESCE(ts.cash_reconciliation->>'variance', 'null'),
       COALESCE((ts.cash_reconciliation->>'variance')::numeric, 1) = 0
FROM tagged_sessions ts

ORDER BY 1;
