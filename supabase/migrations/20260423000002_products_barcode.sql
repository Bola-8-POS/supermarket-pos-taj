-- Sprint 13: add barcode column to products for USB scanner lookup.
alter table public.products
  add column if not exists barcode text;

create unique index if not exists products_barcode_unique
  on public.products (barcode)
  where barcode is not null;
