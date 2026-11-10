BEGIN;

ALTER TABLE order_items ADD COLUMN cost_price_snapshot numeric(10,2);

NOTIFY pgrst, 'reload schema';

COMMIT;
